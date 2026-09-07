/**
 * Браузерная половина dsh-session-control.
 *
 * Плагин состоит из двух независимых половин.
 *
 * Половина «СЕРВИС» отдаёт `uiWorkspace` вместо выключенного ядрового ряда
 * ui-workspace. Этот сервис стоит в ОБЯЗАТЕЛЬНОМ inject у
 * dsh-client-ui-sidebar и dsh-client-ui-conversation, поэтому без него не
 * поднимутся ни боковая панель, ни интерфейс беседы — экран будет пустой.
 * Её единственная задача — никогда не падать: ни React, ни нашей логики, ни
 * настроек здесь нет и быть не должно.
 *
 * Половина «ИНТЕРФЕЙС» — наш список сессий в слоте sidebar.workspaces, выбор
 * папки в conversation.hero.workspace и карточка настроек. Она поднимается в
 * отдельном дочернем контексте и целиком обёрнута в try/catch: её отказ
 * оставляет слот пустым, но приложение живым.
 */
window.__ModuleLoader__.load({
  id: '@goodandready/dsh-session-control',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const cordis = require('@deepseek-ai/cordis')

    /**
     * Папка, в которой работали последней.
     *
     * Свежесть папки — это максимальное `updatedAt` среди её сессий; у папки
     * без сессий берём время создания, иначе новая пустая папка никогда не
     * выигрывала бы. Порядок обхода задаёт хост, поэтому при равенстве времён
     * выбор устойчив.
     */
    function recentWorkspace(workspaces, sessions) {
      let selected
      let selectedTime = Number.NEGATIVE_INFINITY
      for (const workspace of workspaces) {
        let latest = Number.NEGATIVE_INFINITY
        for (const sessionId of workspace.sessionIds) {
          const session = sessions[sessionId]
          if (session !== undefined) latest = Math.max(latest, session.updatedAt)
        }
        if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
        if (selected === undefined || latest > selectedTime) {
          selected = workspace.workspaceId
          selectedTime = latest
        }
      }
      return selected
    }

    /** Отказ выбора каталога, донесённый до вызывающего без потери кода. */
    class DirectoryBrowseError extends Error {
      constructor(rpcError) {
        super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
        this.rpcError = rpcError
      }
    }

    /**
     * Операции над папками и каталогами, которых ждут ядровые модули.
     *
     * Поверхность повторяет ядровую дословно: любое расхождение здесь выходит
     * наружу не ошибкой, а неработающей кнопкой в чужом модуле.
     */
    class UiWorkspaceService extends cordis.Service {
      constructor(ctx, directoryPicker, workspaces, sessions) {
        super(ctx, 'uiWorkspace')
        this.directoryPicker = directoryPicker
        this.workspaces = workspaces
        this.sessions = sessions
        /** Незавершённые подключения по папкам: защита от двойного создания. */
        this.connecting = new Map()
        ctx.effect(() => this.watchNavigation(), 'dsh-session-control: политика выбора папки')
      }

      /**
       * Вернуть сессию, в которую попадёт пользователь при переходе в папку.
       *
       * Пустую сессию папки переиспользуем вместо создания новой: иначе каждый
       * щелчок по папке плодил бы «Новая сессия».
       */
      async connectWorkspace(workspaceId) {
        const workspace = this.workspaces.list
          .getSnapshot()
          .items.find((item) => item.workspaceId === workspaceId)
        if (workspace === undefined) {
          throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`)
        }

        const inflight = this.connecting.get(workspaceId)
        if (inflight !== undefined) return inflight

        const archived = this.workspaces.list.getSnapshot().archivedSessionIds
        const sessions = this.sessions.list.getSnapshot()
        for (const id of sessions.ids) {
          const summary = sessions.byId[id]
          if (
            summary !== undefined &&
            summary.blank &&
            summary.cwd === workspace.path &&
            workspace.sessionIds.includes(summary.id) &&
            !archived.includes(summary.id)
          ) {
            return summary.id
          }
        }

        const attempt = this.sessions.create({ workspaceId }).finally(() => {
          this.connecting.delete(workspaceId)
        })
        this.connecting.set(workspaceId, attempt)
        return attempt
      }

      /**
       * Начать работу: в указанной папке, иначе в текущей, иначе в последней.
       *
       * Если папок нет вовсе, просто снимаем выбор — пользователь окажется на
       * пустом экране беседы, где ему предложат создать папку.
       */
      startSession(workspaceId) {
        const workspace = this.workspaces.list.getSnapshot()
        const sessions = this.sessions.list.getSnapshot()
        const current = sessions.current
        const currentWorkspaceId =
          current === undefined
            ? undefined
            : workspace.items.find((item) => item.sessionIds.includes(current))?.workspaceId
        const recent =
          workspace.phase === 'ready' && sessions.phase === 'ready'
            ? recentWorkspace(workspace.items, sessions.byId)
            : undefined

        const target = workspaceId ?? currentWorkspaceId ?? recent
        if (target === undefined) {
          this.sessions.clear()
          return
        }

        this.connectWorkspace(target).then(
          (sessionId) => {
            this.sessions.open(sessionId)
          },
          (reason) => {
            console.warn('[dsh-session-control] не удалось начать сессию:', reason)
          },
        )
      }

      async archiveSession(sessionId) {
        await this.workspaces.archiveSession(sessionId)
      }

      async pickDirectory() {
        const result = await this.directoryPicker.pick()
        if (!result.ok) throw new Error(`directory picker failed: ${result.error.message}`)
        return result.value
      }

      async listDirectory(path, signal) {
        const result = await this.directoryPicker.list(path, signal)
        if (!result.ok) throw new DirectoryBrowseError(result.error)
        return result.value
      }

      async createDirectory(path, name) {
        const result = await this.directoryPicker.createDirectory(path, name)
        if (!result.ok) throw new DirectoryBrowseError(result.error)
        return result.value
      }

      /**
       * Один раз за загрузку открыть последнюю папку и всегда снимать выбор с
       * заархивированной сессии.
       *
       * Начальный выбор делается ровно однажды: `initial` не даёт повторить его
       * после того, как пользователь сам куда-то перешёл. При неудаче
       * возвращаемся в `waiting`, чтобы следующая перерисовка попробовала снова.
       */
      watchNavigation() {
        let initial = 'waiting'
        let disposed = false

        const reconcile = () => {
          if (disposed) return
          if (this.clearArchivedCurrent()) return
          if (initial !== 'waiting') return

          const workspace = this.workspaces.list.getSnapshot()
          const sessions = this.sessions.list.getSnapshot()
          if (workspace.phase !== 'ready' || sessions.phase !== 'ready') return
          if (sessions.current !== undefined) {
            initial = 'done'
            return
          }

          const target = recentWorkspace(workspace.items, sessions.byId)
          if (target === undefined) {
            initial = 'done'
            return
          }

          initial = 'connecting'
          this.connectWorkspace(target).then(
            (sessionId) => {
              if (disposed) return
              if (this.sessions.list.getSnapshot().current === undefined) {
                this.sessions.open(sessionId)
              }
              initial = 'done'
            },
            (reason) => {
              if (disposed) return
              initial = 'waiting'
              console.warn('[dsh-session-control] не удалось открыть последнюю папку:', reason)
            },
          )
        }

        const disposeWorkspaces = this.workspaces.list.subscribe(reconcile)
        const disposeSessions = this.sessions.list.subscribe(reconcile)
        reconcile()

        return () => {
          disposed = true
          disposeSessions()
          disposeWorkspaces()
        }
      }

      /**
       * @returns true, если выбор пришлось снять с заархивированной сессии.
       */
      clearArchivedCurrent() {
        const current = this.sessions.list.getSnapshot().current
        if (
          current === undefined ||
          !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)
        ) {
          return false
        }
        this.sessions.clear()
        return true
      }
    }

    // ================================================================
    // Половина «ИНТЕРФЕЙС»
    //
    // Всё ниже необязательно для жизни приложения: если здесь что-то
    // сломается, слот sidebar.workspaces останется пустым, но панель,
    // настройки и беседа продолжат работать за счёт половины «сервис».
    // Поэтому регистрация идёт в отдельном дочернем контексте и целиком
    // в try/catch.
    // ================================================================

    const React = require('react')
    const h = React.createElement

    /** Значок раскрытия берём у ядра: свой треугольник выдаёт самоделку. */
    let ChevronIcon = null
    let SearchIcon = null
    let AddIcon = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      ChevronIcon = primitives && primitives.IconChevronDownOutline14
      SearchIcon = primitives && primitives.IconSearchOutline16
      AddIcon = primitives && primitives.IconProjectAddOutline16
    } catch (noPrimitives) {
      // В урезанной сборке набора может не быть: незащищённый require уронил
      // бы всю клиентскую половину.
      ChevronIcon = null
    }

    function FallbackChevron(props) {
      return h(
        'svg',
        { className: props.className, width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3.5 5.5 7 9l3.5-3.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function FallbackSearch(props) {
      return h('svg', { className: props.className, width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('circle', { cx: 7, cy: 7, r: 4.25, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'm10.4 10.4 3 3', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
    }

    function FallbackAdd(props) {
      return h('svg', { className: props.className, width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', { d: 'M8 3.5v9M3.5 8h9', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
    }

    const Chevron = ChevronIcon || FallbackChevron
    const Search = SearchIcon || FallbackSearch
    const Add = AddIcon || FallbackAdd

    const STYLE_ID = 'dsc-styles'

    /**
     * Стили вносим один раз на документ.
     *
     * Горизонтальный отступ берём из ядровой переменной, которую задаёт
     * боковая панель: только так наш блок совпадает по вертикали с кнопкой
     * «Новая сессия» над ним. Своё число здесь означало бы рассинхрон при
     * любой правке ядра.
     */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dsc-root { display:flex; flex-direction:column; min-height:0; flex:1;
  padding-inline: var(--dsh-sidebar-inline-padding, 12px); gap:2px }
.dsc-head { display:flex; align-items:center; gap:6px; height:28px;
  color:var(--dsw-alias-label-secondary); font-size:12px }
.dsc-head-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.dsc-icon-btn { appearance:none; background:0 0; border:0; cursor:pointer; padding:4px;
  border-radius:6px; color:var(--dsw-alias-label-tertiary); display:inline-flex;
  align-items:center; justify-content:center; transition:background-color .12s var(--ds-ease-in-out, ease) }
.dsc-icon-btn:hover { background:var(--dsw-alias-interactive-bg-hover) }
.dsc-icon-btn:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px }
.dsc-search { width:100%; height:28px; box-sizing:border-box; margin:2px 0 6px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:8px; padding:0 8px;
  font:inherit; font-size:13px; background:0 0; color:var(--dsw-alias-label-primary) }
.dsc-list { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent }
.dsc-section { margin-top:4px }
.dsc-section-head { appearance:none; width:100%; font:inherit; color:var(--dsw-alias-label-secondary);
  text-align:left; cursor:pointer; background:0 0; border:0; border-radius:6px;
  display:flex; align-items:center; gap:6px; padding:4px 6px; font-size:12px }
.dsc-section-head:hover { background:var(--dsw-alias-interactive-bg-hover) }
.dsc-section-head:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:-2px }
.dsc-section-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.dsc-count { color:var(--dsw-alias-label-tertiary); font-size:11px; flex:none }
.dsc-chev { flex:none; color:var(--dsw-alias-label-tertiary); transition:transform .16s var(--ds-ease-in-out, ease) }
.dsc-chev-collapsed { transform:rotate(-90deg) }
.dsc-row { display:flex; align-items:center; gap:6px; width:100%; box-sizing:border-box;
  padding:5px 6px; border-radius:6px; cursor:pointer; border:0; background:0 0;
  font:inherit; text-align:left; color:var(--dsw-alias-label-primary);
  transition:background-color .12s var(--ds-ease-in-out, ease) }
.dsc-row:hover { background:var(--dsw-alias-interactive-bg-hover) }
.dsc-row:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:-2px }
.dsc-row-current { background:var(--dsw-alias-interactive-bg-hover) }
.dsc-row-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px }
.dsc-row-age { flex:none; color:var(--dsw-alias-label-secondary); font-size:11px }
.dsc-dot { flex:none; width:6px; height:6px; border-radius:50%;
  background:var(--dsw-alias-state-business-primary) }
.dsc-pin { flex:none; color:var(--dsw-alias-label-tertiary); font-size:11px }
.dsc-more { flex:none; opacity:0; padding:2px 4px; border-radius:4px; border:0; background:0 0;
  color:var(--dsw-alias-label-tertiary); cursor:pointer; font:inherit }
.dsc-row:hover .dsc-more, .dsc-more:focus-visible { opacity:1 }
.dsc-check { flex:none; margin:0 2px 0 0; opacity:0; cursor:pointer }
.dsc-row:hover .dsc-check, .dsc-check:focus-visible, .dsc-check-on { opacity:1 }
.dsc-bulk { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  border-top:1px solid var(--dsw-alias-border-l2); padding:8px 6px 4px;
  color:var(--dsw-alias-label-secondary); font-size:12px }
.dsc-bulk-count { flex:none; color:var(--dsw-alias-label-primary) }
.dsc-bulk-act { appearance:none; font:inherit; font-size:12px; cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:3px 9px;
  background:0 0; color:var(--dsw-alias-label-primary) }
.dsc-bulk-act:hover { background:var(--dsw-alias-interactive-bg-hover) }
.dsc-row-lines { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px }
.dsc-row-snippet { color:var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary));
  font-size:11px; line-height:1.35; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.dsc-chips { display:flex; flex-wrap:wrap; gap:4px; padding:2px 2px 6px }
.dsc-chip { appearance:none; font:inherit; font-size:11px; cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2); border-radius:999px; padding:2px 9px;
  background:0 0; color:var(--dsw-alias-label-secondary) }
.dsc-chip:hover { background:var(--dsw-alias-interactive-bg-hover) }
.dsc-chip-on { color:var(--dsw-alias-label-primary);
  border-color:var(--dsw-alias-state-business-primary) }
.dsc-jump { position:fixed; inset:0; z-index:90; display:flex; justify-content:center;
  align-items:flex-start; padding-top:12vh; background:rgba(0,0,0,.45) }
.dsc-jump-box { display:flex; flex-direction:column; width:min(620px,92vw); max-height:64vh;
  border:1px solid var(--dsw-alias-border-l2); border-radius:12px;
  background:var(--dsw-alias-bg-layer-3); overflow:hidden }
.dsc-jump-input { border:0; border-bottom:1px solid var(--dsw-alias-border-l2); background:0 0;
  font:inherit; font-size:15px; padding:14px 16px; color:var(--dsw-alias-label-primary) }
.dsc-jump-input:focus { outline:0 }
.dsc-jump-list { flex:1; min-height:0; overflow-y:auto; padding:6px }
.dsc-jump-row { display:flex; align-items:center; gap:8px; width:100%; box-sizing:border-box;
  border:0; background:0 0; font:inherit; text-align:left; cursor:pointer; border-radius:8px;
  padding:8px 10px; color:var(--dsw-alias-label-primary) }
.dsc-jump-row-on { background:var(--dsw-alias-interactive-bg-hover) }
.dsc-jump-lines { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px }
.dsc-jump-title { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.dsc-jump-snippet { font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary)) }
.dsc-jump-tag { flex:none; font-size:11px; color:var(--dsw-alias-label-tertiary) }
.dsc-jump-hint { border-top:1px solid var(--dsw-alias-border-l2); padding:8px 16px;
  color:var(--dsw-alias-label-tertiary); font-size:11px }
.dsc-viewer-act { appearance:none; font:inherit; font-size:12px; cursor:pointer; flex:none;
  border:1px solid var(--dsw-alias-border-l2); border-radius:8px; padding:4px 10px;
  background:0 0; color:var(--dsw-alias-label-primary) }
.dsc-viewer-act:hover { background:var(--dsw-alias-interactive-bg-hover) }
.dsc-rename { flex:1; min-width:0; height:22px; box-sizing:border-box; font:inherit; font-size:13px;
  border:1px solid var(--dsw-alias-state-business-primary); border-radius:4px; padding:0 4px;
  background:0 0; color:var(--dsw-alias-label-primary) }
.dsc-menu { position:fixed; z-index:60; min-width:190px; padding:4px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:10px;
  background:var(--dsw-alias-bg-layer-3); box-shadow:0 8px 24px rgba(0,0,0,.28) }
.dsc-menu-item { appearance:none; display:block; width:100%; font:inherit; font-size:13px;
  text-align:left; border:0; background:0 0; cursor:pointer; padding:6px 10px; border-radius:6px;
  color:var(--dsw-alias-label-primary) }
.dsc-menu-item:hover { background:var(--dsw-alias-interactive-bg-hover) }
.dsc-menu-item:disabled { color:var(--dsw-alias-label-tertiary); cursor:default; background:0 0 }
.dsc-menu-sep { height:1px; margin:4px 6px; background:var(--dsw-alias-border-l2) }
.dsc-menu-danger { color:var(--dsw-alias-state-error-primary) }
.dsc-empty { padding:10px 6px; color:var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary));
  font-size:12px; line-height:1.5 }
.dsc-error { padding:4px 6px; color:var(--dsw-alias-state-error-primary); font-size:12px }
.dsc-skeleton { height:26px; margin:3px 6px; border-radius:6px;
  background:var(--dsw-alias-interactive-bg-hover); opacity:.5 }
.dsc-viewer { position:fixed; inset:0; z-index:80; display:flex; align-items:center;
  justify-content:center; background:rgba(0,0,0,.45) }
.dsc-viewer-box { display:flex; flex-direction:column; width:min(860px,92vw); height:min(80vh,900px);
  border:1px solid var(--dsw-alias-border-l2); border-radius:12px;
  background:var(--dsw-alias-bg-layer-3); overflow:hidden }
.dsc-viewer-head { display:flex; align-items:center; gap:12px; padding:14px 16px;
  border-bottom:1px solid var(--dsw-alias-border-l2) }
.dsc-viewer-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--dsw-alias-label-primary); font-size:15px; font-weight:600 }
.dsc-viewer-note { color:var(--dsw-alias-label-secondary); font-size:12px; flex:none }
.dsc-viewer-body { flex:1; min-height:0; overflow-y:auto; padding:12px 16px }
.dsc-msg { padding:10px 0; border-bottom:1px solid var(--dsw-alias-border-l2) }
.dsc-msg:last-child { border-bottom:0 }
.dsc-msg-role { color:var(--dsw-alias-label-secondary); font-size:11px;
  text-transform:uppercase; letter-spacing:.04em; margin-bottom:4px }
.dsc-msg-user .dsc-msg-role { color:var(--dsw-alias-state-business-primary) }
.dsc-msg-text { color:var(--dsw-alias-label-primary); font-size:13px; line-height:1.55;
  white-space:pre-wrap; overflow-wrap:anywhere }
.dsc-msg-tool { color:var(--dsw-alias-label-tertiary); font-size:12px;
  font-family:var(--ds-font-family-code, monospace) }
.dsc-viewer-cut { color:var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary));
  font-size:12px; padding:8px 0 12px }
.dsc-card { border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-3); border-radius:12px; list-style:none }
.dsc-card-head { appearance:none; width:100%; font:inherit; color:inherit; text-align:left;
  cursor:pointer; background:0 0; border:0; border-radius:12px; display:flex;
  align-items:center; gap:12px; padding:14px 16px }
.dsc-card-head:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:-2px }
.dsc-card-text { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px }
.dsc-card-title { color:var(--dsw-alias-label-primary); font-size:15px; font-weight:600; line-height:1.4 }
.dsc-card-sub { color:var(--dsw-alias-label-secondary); font-size:13px }
.dsc-card-chev { margin-left:auto; flex:none; color:var(--dsw-alias-label-tertiary);
  transition:transform .16s var(--ds-ease-in-out, ease) }
.dsc-card-chev-open { transform:rotate(180deg) }
.dsc-card-body { border-top:1px solid var(--dsw-alias-border-l2); margin:0 16px; padding:12px 0 }
.dsc-card-stat { color:var(--dsw-alias-label-secondary); font-size:13px }
.dsc-card-toggle { display:flex; align-items:center; gap:8px; margin-top:10px;
  color:var(--dsw-alias-label-primary); font-size:13px; cursor:pointer }
.dsc-card-action { appearance:none; font:inherit; font-size:13px; cursor:pointer; margin-top:10px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:8px; padding:5px 12px;
  background:0 0; color:var(--dsw-alias-label-primary) }
.dsc-card-action:disabled { color:var(--dsw-alias-label-tertiary); cursor:default }
.dsc-rail { display:flex; flex-direction:column; align-items:center; gap:6px; padding-top:4px }
.dsc-rail-btn { width:36px; height:36px; border-radius:8px; border:0; background:0 0; cursor:pointer;
  color:var(--dsw-alias-label-tertiary); display:flex; align-items:center; justify-content:center }
.dsc-rail-btn:hover { background:var(--dsw-alias-interactive-bg-hover) }
`
      document.head.appendChild(style)
    }

    /** Возраст строки: те же ступени, что показывает ядро. */
    function formatAge(t, updatedAt) {
      const diff = Date.now() - updatedAt
      if (!Number.isFinite(diff) || diff < 0) return ''
      const min = Math.floor(diff / 60000)
      if (min < 1) return t('age.now')
      if (min < 60) return t('age.min', { n: min })
      const hours = Math.floor(min / 60)
      if (hours < 24) return t('age.hour', { n: hours })
      return t('age.day', { n: Math.floor(hours / 24) })
    }

    /**
     * Период, к которому относится строка.
     *
     * Границы календарные, а не «минус столько-то часов»: человек мыслит
     * «сегодня» и «на этой неделе», а не сутками от текущего момента.
     *
     * @param updatedAt - время последнего события строки.
     * @param now - текущее время.
     * @returns ключ периода.
     */
    function periodOf(updatedAt, now) {
      const day = new Date(now); day.setHours(0, 0, 0, 0)
      const startOfToday = day.getTime()
      if (updatedAt >= startOfToday) return 'today'
      if (updatedAt >= startOfToday - 6 * 86400000) return 'week'
      if (updatedAt >= startOfToday - 29 * 86400000) return 'month'
      return 'older'
    }

    /** Периоды в порядке показа. */
    const PERIODS = ['today', 'week', 'month', 'older']

    /** Подписка на пространство настроек. Статус важнее значения. */
    function useSettings(scope) {
      const snapshot = React.useSyncExternalStore(
        React.useMemo(() => (cb) => (scope ? scope.subscribe(cb) : () => {}), [scope]),
        React.useCallback(() => (scope ? scope.getSnapshot() : { status: 'loading' }), [scope]),
        React.useCallback(() => ({ status: 'loading' }), []),
      )
      const status = (snapshot && snapshot.status) || 'loading'
      const value = (snapshot && snapshot.value) || {}
      return {
        status,
        pinned: Array.isArray(value.pinned) ? value.pinned : [],
        hidden: Array.isArray(value.hidden) ? value.hidden : [],
        // Пока настройки не пришли, прячем: так список сразу выглядит как
        // после загрузки, без скачка от мусора к чистому виду.
        hideBlank: value.hideBlank !== false,
        // Метки — наша замена переносу между папками. Ядро о них не знает.
        labels: (value.labels && typeof value.labels === 'object') ? value.labels : {},
        writable: status === 'ready',
      }
    }

    /**
     * Свёрнутость разделов — видовое состояние одного браузера, а не общая
     * настройка: держим её локально и не гоняем через хост.
     */
    function useCollapsed() {
      const [state, setState] = React.useState(() => {
        try {
          return JSON.parse(window.localStorage.getItem('dsc.collapsed') || '{}') || {}
        } catch (noStorage) {
          return {}
        }
      })
      // У разделов разные умолчания: папки развёрнуты, «Скрытые» и «Архив»
      // свёрнуты. Поэтому и чтение, и переключение обязаны знать умолчание
      // раздела: иначе первое нажатие пишет то же значение, которое уже
      // подразумевалось, и раздел открывается только со второго раза.
      const isCollapsed = React.useCallback(
        (key, byDefault) => (state[key] === undefined ? byDefault : state[key] === true),
        [state],
      )
      const toggle = React.useCallback((key, byDefault) => {
        setState((prev) => {
          const current = prev[key] === undefined ? byDefault : prev[key] === true
          const next = Object.assign({}, prev, { [key]: !current })
          try { window.localStorage.setItem('dsc.collapsed', JSON.stringify(next)) } catch (noStorage) {}
          return next
        })
      }, [])
      return [isCollapsed, toggle]
    }

    /** Контекстное меню строки. Закрывается по Escape и щелчку мимо. */
    function RowMenu({ at, items, onClose }) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        const onDown = (e) => {
          if (ref.current && !ref.current.contains(e.target)) onClose()
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('mousedown', onDown)
        }
      }, [onClose])

      return h(
        'div',
        { className: 'dsc-menu', style: { left: at.x + 'px', top: at.y + 'px' }, ref, role: 'menu' },
        items.map((item, i) =>
          item.separator
            ? h('div', { key: 'sep' + i, className: 'dsc-menu-sep' })
            : h(
                'button',
                {
                  key: item.key,
                  type: 'button',
                  role: 'menuitem',
                  disabled: item.disabled === true,
                  className: 'dsc-menu-item' + (item.danger ? ' dsc-menu-danger' : ''),
                  onClick: () => { onClose(); item.run() },
                },
                item.label,
              ),
        ),
      )
    }

    /** Одна строка сессии. */
    function SessionRow({ node, current, pinned, snippet, selected, selectable, onSelect, t, onOpen, onMenu, renaming, onRenameCommit, onRenameCancel }) {
      const inputRef = React.useRef(null)
      React.useEffect(() => {
        if (renaming && inputRef.current) {
          inputRef.current.focus()
          inputRef.current.select()
        }
      }, [renaming])

      const title = node.blank ? t('row.blank') : (node.title || t('row.untitled'))

      if (renaming) {
        return h(
          'div',
          { className: 'dsc-row' },
          h('input', {
            ref: inputRef,
            className: 'dsc-rename',
            defaultValue: title,
            aria: undefined,
            'aria-label': t('menu.rename'),
            onKeyDown: (e) => {
              if (e.key === 'Enter') onRenameCommit(e.currentTarget.value)
              if (e.key === 'Escape') onRenameCancel()
            },
            onBlur: (e) => onRenameCommit(e.currentTarget.value),
          }),
        )
      }

      return h(
        'div',
        {
          className: 'dsc-row' + (current ? ' dsc-row-current' : ''),
          role: 'button',
          tabIndex: 0,
          onClick: () => onOpen(node.id),
          onDoubleClick: (e) => { e.preventDefault(); onMenu(null, node, 'rename') },
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(node.id) }
            if (e.key === 'F2') { e.preventDefault(); onMenu(null, node, 'rename') }
          },
          onContextMenu: (e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }, node) },
        },
        selectable
          ? h('input', {
              type: 'checkbox',
              className: 'dsc-check' + (selected ? ' dsc-check-on' : ''),
              checked: selected === true,
              'aria-label': t('bulk.select'),
              // Клик по галочке не должен открывать сессию: выбор и открытие —
              // разные намерения.
              onClick: (e) => { e.stopPropagation(); onSelect(node.id, e.shiftKey) },
              onChange: () => {},
            })
          : null,
        pinned ? h('span', { className: 'dsc-pin', title: t('menu.unpin'), 'aria-hidden': 'true' }, '•') : null,
        h('span', { className: 'dsc-row-lines' },
          h('span', { className: 'dsc-row-title' }, title),
          // Сниппет показываем только во время поиска: он объясняет, ЧЕМ
          // строка нашлась, и вне поиска объяснять нечего.
          snippet ? h('span', { className: 'dsc-row-snippet', title: snippet }, snippet) : null),
        node.running
          ? h('span', { className: 'dsc-dot', role: 'img', 'aria-label': t('row.running') })
          : h('span', { className: 'dsc-row-age' }, formatAge(t, node.updatedAt)),
        h(
          'button',
          {
            type: 'button',
            className: 'dsc-more',
            'aria-label': t('row.menu'),
            onClick: (e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              onMenu({ x: Math.round(r.left - 150), y: Math.round(r.bottom + 4) }, node)
            },
          },
          '···',
        ),
      )
    }

    /** Свёртываемый раздел с заголовком-кнопкой. */
    function Section({ id, name, count, collapsed, defaultCollapsed, onToggle, children }) {
      return h(
        'div',
        { className: 'dsc-section' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsc-section-head',
            'aria-expanded': collapsed ? 'false' : 'true',
            onClick: () => onToggle(id, defaultCollapsed === true),
          },
          h(Chevron, { className: 'dsc-chev' + (collapsed ? ' dsc-chev-collapsed' : '') }),
          h('span', { className: 'dsc-section-name' }, name),
          h('span', { className: 'dsc-count' }, String(count)),
        ),
        collapsed ? null : children,
      )
    }

    /**
     * Расшифровка заархивированной сессии, только на чтение.
     *
     * Читаем не через клиентский менеджер сессий, а своим маршрутом. Причина
     * в устройстве клиента: окно истории поднимается только для сессии «на
     * сцене», то есть текущей, а заархивированная текущей быть не может.
     * Серверная половина берёт лог штатным `sessionPersistence.readRaw`, не
     * поднимая живую сессию.
     */
    function ArchiveViewer({ sessionId, title, t, onClose }) {
      const [state, setState] = React.useState({ phase: 'loading', messages: [], truncated: false, total: 0 })

      React.useEffect(() => {
        let dropped = false
        const controller = new AbortController()
        fetch('/dsh-session-control/transcript?session=' + encodeURIComponent(sessionId),
              { signal: controller.signal })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (dropped) return
            if (!response.ok || body.ok !== true) {
              setState({ phase: 'failed', error: body.error || ('HTTP ' + response.status),
                         messages: [], truncated: false, total: 0 })
              return
            }
            setState({ phase: body.unreadable === true ? 'unreadable' : 'ready',
                       messages: body.messages || [],
                       truncated: body.truncated === true, total: body.total || 0 })
          })
          .catch((failure) => {
            if (dropped || (failure && failure.name === 'AbortError')) return
            setState({ phase: 'failed', error: (failure && failure.message) || String(failure),
                       messages: [], truncated: false, total: 0 })
          })
        return () => { dropped = true; controller.abort() }
      }, [sessionId])

      React.useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])

      const [note, setNote] = React.useState('')

      // Markdown собирает серверная половина: логика сборки одна на всех и
      // покрыта тестами, а браузеру остаётся забрать готовый текст.
      const grab = () => fetch('/dsh-session-control/transcript?session='
          + encodeURIComponent(sessionId) + '&format=md&title=' + encodeURIComponent(title))
        .then((response) => {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.text()
        })

      const failExport = (failure) => {
        setNote(t('viewer.exportFailed', { message: (failure && failure.message) || String(failure) }))
      }

      const copyMarkdown = () => {
        setNote('')
        grab().then((text) => {
          // Буфер обмена недоступен без защищённого соединения: тогда честно
          // говорим об этом и оставляем сохранение файлом.
          if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
            throw new Error(t('viewer.noClipboard'))
          }
          return navigator.clipboard.writeText(text)
        }).then(() => setNote(t('viewer.copied')), failExport)
      }

      const saveMarkdown = () => {
        setNote('')
        grab().then((text) => {
          const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
          const link = document.createElement('a')
          link.href = url
          link.download = (String(title || 'session').replace(/[^\p{L}\p{N} _-]+/gu, '').trim()
            || 'session') + '.md'
          link.click()
          URL.revokeObjectURL(url)
        }, failExport)
      }

      let body
      if (state.phase === 'loading') {
        body = h('div', { className: 'dsc-empty' }, t('viewer.loading'))
      } else if (state.phase === 'failed') {
        body = h('div', { className: 'dsc-error' }, t('viewer.failed', { message: state.error }))
      } else if (state.phase === 'unreadable') {
        body = h('div', { className: 'dsc-empty' }, t('viewer.unreadable'))
      } else if (state.messages.length === 0) {
        body = h('div', { className: 'dsc-empty' }, t('viewer.empty'))
      } else {
        const rows = []
        if (state.truncated) {
          rows.push(h('div', { key: 'cut', className: 'dsc-viewer-cut' },
            t('viewer.truncated', { shown: state.messages.length, total: state.total })))
        }
        state.messages.forEach((m, index) => {
          if (m.role === 'tool') {
            rows.push(h('div', { key: 'r' + index, className: 'dsc-msg' },
              h('div', { className: 'dsc-msg-tool' }, t('viewer.tool', { name: m.text }))))
            return
          }
          rows.push(h('div', { key: 'r' + index, className: 'dsc-msg ' + (m.role === 'user' ? 'dsc-msg-user' : '') },
            h('div', { className: 'dsc-msg-role' }, m.role === 'user' ? t('viewer.you') : t('viewer.agent')),
            h('div', { className: 'dsc-msg-text' }, m.text)))
        })
        body = rows
      }

      return h(
        'div',
        { className: 'dsc-viewer', role: 'dialog', 'aria-modal': 'true',
          onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
        h(
          'div',
          { className: 'dsc-viewer-box' },
          h('div', { className: 'dsc-viewer-head' },
            h('span', { className: 'dsc-viewer-title' }, title),
            h('span', { className: 'dsc-viewer-note' }, note === '' ? t('viewer.readonly') : note),
            state.phase === 'ready'
              ? h('button', { type: 'button', className: 'dsc-viewer-act', onClick: copyMarkdown },
                  t('viewer.copy'))
              : null,
            state.phase === 'ready'
              ? h('button', { type: 'button', className: 'dsc-viewer-act', onClick: saveMarkdown },
                  t('viewer.save'))
              : null,
            h('button', { type: 'button', className: 'dsc-icon-btn',
              'aria-label': t('viewer.close'), onClick: onClose }, '\u2715')),
          h('div', { className: 'dsc-viewer-body' }, body),
        ),
      )
    }

    /**
     * Быстрый переход к диалогу с клавиатуры.
     *
     * Ищет тем же путём, что и строка поиска в панели: по названию сразу, по
     * содержимому — через хост, с задержкой. Ничего, кроме перехода, не умеет
     * намеренно: окно поверх интерфейса не место для необратимых действий.
     */
    function QuickJump({ t, sessions, searchSessions, onPick, onClose }) {
      const [query, setQuery] = React.useState('')
      const [remote, setRemote] = React.useState(null)
      const [cursor, setCursor] = React.useState(0)
      const [failed, setFailed] = React.useState('')
      const searchRef = React.useRef(searchSessions)
      searchRef.current = searchSessions

      // Фокус возвращаем туда, откуда окно открыли: иначе после Escape
      // клавиатура остаётся в никуда.
      React.useEffect(() => {
        const previous = document.activeElement
        return () => { if (previous && typeof previous.focus === 'function') previous.focus() }
      }, [])

      React.useEffect(() => {
        const text = query.trim()
        if (text === '') { setRemote(null); setFailed(''); return undefined }
        let cancelled = false
        const controller = new AbortController()
        const timer = setTimeout(() => {
          searchRef.current(text, controller.signal).then(
            (res) => {
              if (cancelled) return
              const byId = {}
              for (const item of res.items) byId[item.sessionId] = item.snippet || ''
              setRemote(byId)
              setFailed('')
            },
            (e) => {
              if (cancelled || (e && e.name === 'AbortError')) return
              setFailed(t('error.search', { message: (e && e.message) || String(e) }))
            },
          )
        }, 250)
        return () => { cancelled = true; clearTimeout(timer); controller.abort() }
      }, [query])

      const rows = React.useMemo(() => {
        const text = query.trim().toLowerCase()
        const out = []
        const seen = new Set()
        for (const s of sessions) {
          if (text !== '' && !s.title.toLowerCase().includes(text)) continue
          seen.add(s.id)
          out.push({ id: s.id, title: s.title, archived: s.archived, snippet: '' })
          if (out.length >= 30) break
        }
        if (remote !== null) {
          for (const s of sessions) {
            if (seen.has(s.id)) continue
            if (!Object.prototype.hasOwnProperty.call(remote, s.id)) continue
            out.push({ id: s.id, title: s.title, archived: s.archived, snippet: remote[s.id] })
            if (out.length >= 60) break
          }
        }
        return out
      }, [sessions, query, remote])

      React.useEffect(() => { setCursor(0) }, [query, remote])

      const move = (step) => {
        if (rows.length === 0) return
        setCursor((prev) => (prev + step + rows.length) % rows.length)
      }

      return h(
        'div',
        { className: 'dsc-jump', role: 'dialog', 'aria-modal': 'true',
          onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
        h(
          'div',
          { className: 'dsc-jump-box' },
          h('input', {
            className: 'dsc-jump-input',
            value: query,
            autoFocus: true,
            placeholder: t('jump.placeholder'),
            'aria-label': t('jump.title'),
            onChange: (e) => setQuery(e.currentTarget.value),
            onKeyDown: (e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
              else if (e.key === 'Enter') {
                e.preventDefault()
                if (rows[cursor] !== undefined) onPick(rows[cursor].id)
              } else if (e.key === 'Escape') { e.preventDefault(); onClose() }
            },
          }),
          failed !== '' ? h('div', { className: 'dsc-error' }, failed) : null,
          h('div', { className: 'dsc-jump-list' },
            rows.length === 0
              ? h('div', { className: 'dsc-empty' }, t('jump.empty'))
              : rows.map((row, index) => h('button', {
                  key: row.id,
                  type: 'button',
                  className: 'dsc-jump-row' + (index === cursor ? ' dsc-jump-row-on' : ''),
                  onMouseEnter: () => setCursor(index),
                  onClick: () => onPick(row.id),
                },
                  h('span', { className: 'dsc-jump-lines' },
                    h('span', { className: 'dsc-jump-title' }, row.title || t('row.untitled')),
                    row.snippet
                      ? h('span', { className: 'dsc-jump-snippet', title: row.snippet }, row.snippet)
                      : null),
                  row.archived ? h('span', { className: 'dsc-jump-tag' }, t('jump.archived')) : null))),
          h('div', { className: 'dsc-jump-hint' }, t('jump.hint')),
        ),
      )
    }

    /** Список диалогов: тело боковой панели. */
    function SessionListPanel(props) {
      const t = props.t
      const settings = useSettings(props.settingsScope)
      const [isCollapsed, toggleCollapsed] = useCollapsed()

      const [query, setQuery] = React.useState('')
      const [searchOpen, setSearchOpen] = React.useState(false)
      const [found, setFound] = React.useState(null)
      const [searchFailed, setSearchFailed] = React.useState('')
      const [menu, setMenu] = React.useState(null)
      const [renamingId, setRenamingId] = React.useState(null)
      const [error, setError] = React.useState('')
      const [flowOpen, setFlowOpen] = React.useState(false)
      const [flowBusy, setFlowBusy] = React.useState(false)
      const [viewing, setViewing] = React.useState(null)
      const [selected, setSelected] = React.useState([])
      const lastPicked = React.useRef(null)
      const [labelFilter, setLabelFilter] = React.useState('')
      const [jumpOpen, setJumpOpen] = React.useState(false)
      // Выведенные подписи: идентификатор -> начало первой фразы человека.
      const [derived, setDerived] = React.useState({})
      // За какие строки уже спрашивали. Спрашиваем один раз за загрузку
      // страницы: первое сообщение сессии не меняется никогда.
      const askedRef = React.useRef(new Set())
      // Строки, которые сейчас нарисованы. Свёрнутый раздел сюда не попадает,
      // поэтому и подписей для него не запрашиваем.
      const renderedRef = React.useRef([])
      const selectedSet = React.useMemo(() => new Set(selected), [selected])
      // Порядок для выбора диапазона: тот же, в котором строки видны.
      // Объявляем рядом с остальным состоянием: заполняется он ниже, при
      // сборке списков, и обращение к нему не должно опережать объявление.
      const orderRef = React.useRef([])

      React.useEffect(() => { ensureStyles() }, [])

      const workspaces = props.useWorkspaces((s) => s.items)
      const workspacePhase = props.useWorkspaces((s) => s.phase)
      const archivedIds = props.useWorkspaces((s) => s.archivedSessionIds)
      const sessionsById = props.useSessions((s) => s.byId)
      const sessionPhase = props.useSessions((s) => s.phase)
      const currentId = props.useSessions((s) => s.current)
      const flowAvailable = props.useDirectoryFlow((occupied) => occupied)

      // Ссылка на поиск живёт в ref, а эффект зависит ТОЛЬКО от строки запроса.
      //
      // Иначе выходит так: панель перерисовывается от любого обновления
      // хранилища сессий, эффект перезапускается и его уборщик отменяет
      // собственный запрос на лету. Внешне это «поиск то находит, то нет» —
      // самый неприятный вид отказа, потому что выглядит как случайность.
      const searchRef = React.useRef(props.searchSessions)
      searchRef.current = props.searchSessions

      // Содержательный поиск идёт на хост с задержкой: без неё каждая буква
      // превращается в запрос.
      React.useEffect(() => {
        const text = query.trim()
        if (text === '') { setFound(null); setSearchFailed(''); return undefined }
        let cancelled = false
        const controller = new AbortController()
        const timer = setTimeout(() => {
          searchRef.current(text, controller.signal).then(
            (res) => {
              if (cancelled) return
              // Держим и сниппет: хост его уже посчитал, выбрасывать нечего.
              const byId = {}
              for (const item of res.items) byId[item.sessionId] = item.snippet || ''
              setFound(byId)
              setSearchFailed('')
            },
            (e) => {
              // Отмену показывать не надо — она наша. Настоящий отказ показать
              // обязаны: молчащий поиск неотличим от пустого результата.
              if (cancelled || (e && e.name === 'AbortError')) return
              setSearchFailed(t('error.search', { message: (e && e.message) || String(e) }))
            },
          )
        }, 250)
        return () => { cancelled = true; clearTimeout(timer); controller.abort() }
      }, [query])

      const nodeOf = React.useCallback((id) => {
        const s = sessionsById[id]
        if (s === undefined) return undefined
        return {
          id,
          title: s.blank ? '' : (s.displayTitle || s.title || ''),
          // Сохранённое название ставит человек переименованием, и оно всегда
          // главнее выведенного нами.
          named: typeof s.title === 'string' && s.title !== '',
          blank: s.blank === true,
          running: s.running === true,
          updatedAt: s.updatedAt || 0,
        }
      }, [sessionsById])

      // Пустая сессия — мусор от расписаний и мессенджера, КРОМЕ текущей:
      // её человек открыл сам и вот-вот начнёт в неё писать.
      const visible = React.useCallback(
        (node) => !(settings.hideBlank && node.blank && node.id !== currentId),
        [settings.hideBlank, currentId],
      )

      const pinnedSet = React.useMemo(() => new Set(settings.pinned), [settings.pinned])
      const hiddenSet = React.useMemo(() => new Set(settings.hidden), [settings.hidden])
      const archivedSet = React.useMemo(() => new Set(archivedIds || []), [archivedIds])

      const labels = settings.labels
      const labelNames = React.useMemo(() => Object.keys(labels).sort(), [labels])

      // Метка исчезла вместе с последней своей сессией — фильтр по ней держать
      // нельзя, иначе панель окажется пустой без объяснения.
      React.useEffect(() => {
        if (labelFilter !== '' && !Object.prototype.hasOwnProperty.call(labels, labelFilter)) {
          setLabelFilter('')
        }
      }, [labels, labelFilter])

      const inLabel = React.useCallback((node) => {
        if (labelFilter === '') return true
        const ids = labels[labelFilter]
        return Array.isArray(ids) && ids.includes(node.id)
      }, [labelFilter, labels])

      const matches = React.useCallback((node) => {
        if (!inLabel(node)) return false
        const text = query.trim().toLowerCase()
        if (text === '') return true
        if (node.title.toLowerCase().includes(text)) return true
        return found !== null && Object.prototype.hasOwnProperty.call(found, node.id)
      }, [query, found, inLabel])

      const pinnedRows = settings.pinned
        .map(nodeOf)
        .filter((n) => n !== undefined && !hiddenSet.has(n.id) && !archivedSet.has(n.id)
                       && visible(n) && matches(n))

      const groups = (workspaces || []).map((w) => ({
        id: w.workspaceId,
        title: w.title,
        rows: (w.sessionIds || [])
          .filter((id) => !pinnedSet.has(id) && !hiddenSet.has(id) && !archivedSet.has(id))
          .map(nodeOf)
          .filter((n) => n !== undefined && visible(n) && matches(n)),
      }))

      const hiddenRows = settings.hidden.map(nodeOf).filter((n) => n !== undefined && matches(n))
      const archiveRows = (archivedIds || []).map(nodeOf).filter((n) => n !== undefined && matches(n))

      const archiveByPeriod = React.useMemo(() => {
        const now = Date.now()
        const buckets = { today: [], week: [], month: [], older: [] }
        for (const row of archiveRows) buckets[periodOf(row.updatedAt, now)].push(row)
        return buckets
      }, [archiveRows])

      // Плоский порядок всех видимых строк — по нему считается диапазон при
      // выборе с Shift.
      orderRef.current = []
        .concat(pinnedRows.map((r) => r.id))
        .concat(...groups.map((g) => g.rows.map((r) => r.id)))
        .concat(hiddenRows.map((r) => r.id))
        .concat(...PERIODS.map((p) => archiveByPeriod[p].map((r) => r.id)))

      // Выбор не переживает смену запроса: после фильтра на экране другие
      // строки, и молча действовать над невидимым нельзя.
      React.useEffect(() => { setSelected([]); lastPicked.current = null }, [query, labelFilter])

      const writeList = async (key, next) => {
        setError('')
        try {
          await props.settingsScope.set(key, next)
        } catch (e) {
          setError(t('error.save', { message: (e && e.message) || String(e) }))
        }
      }

      /**
       * Повесить или снять метку на набор сессий.
       *
       * Опустевшая метка удаляется сама: держать в настройках имя, за которым
       * ничего нет, значит копить мусор в строке фильтра.
       */
      const setLabel = (name, sessionIds, on) => {
        const current = Array.isArray(labels[name]) ? labels[name] : []
        const next = Object.assign({}, labels)
        if (on) {
          next[name] = current.concat(sessionIds.filter((id) => !current.includes(id)))
        } else {
          const left = current.filter((id) => !sessionIds.includes(id))
          if (left.length === 0) delete next[name]
          else next[name] = left
        }
        writeList('labels', next)
      }

      const askLabel = (sessionIds) => {
        const name = String(window.prompt(t('label.prompt')) || '').trim()
        if (name !== '') setLabel(name, sessionIds, true)
      }

      const togglePin = (id) => {
        const next = pinnedSet.has(id)
          ? settings.pinned.filter((x) => x !== id)
          : settings.pinned.concat([id])
        writeList('pinned', next)
      }

      const toggleHidden = (id) => {
        const next = hiddenSet.has(id)
          ? settings.hidden.filter((x) => x !== id)
          : settings.hidden.concat([id])
        writeList('hidden', next)
      }

      // Переноса между папками в меню нет и быть не может: рабочая папка —
      // это каталог, а членство сессии выводится из её рабочего каталога.
      // Хост проверяет это в attachSession и отвергает сессию, чей cwd не
      // совпадает с путём папки. Именно поэтому такого пункта нет и в
      // ядровой панели.
      const openMenu = (at, node, intent) => {
        if (intent === 'rename') { setRenamingId(node.id); return }
        const items = [
          {
            key: 'pin',
            label: pinnedSet.has(node.id) ? t('menu.unpin') : t('menu.pin'),
            disabled: !settings.writable,
            run: () => togglePin(node.id),
          },
          { key: 'rename', label: t('menu.rename'), run: () => setRenamingId(node.id) },
          { key: 'fork', label: t('menu.fork'), run: () => props.forkSession(node.id) },
          { separator: true },
        ]
        items.push({
          key: 'hide',
          label: hiddenSet.has(node.id) ? t('menu.unhide') : t('menu.hide'),
          disabled: !settings.writable,
          run: () => toggleHidden(node.id),
        })
        // Метки отделены от скрытия: без разделителя они читались как
        // продолжение того же действия.
        if (labelNames.length > 0) items.push({ separator: true })
        for (const name of labelNames) {
          const on = Array.isArray(labels[name]) && labels[name].includes(node.id)
          items.push({
            key: 'label:' + name,
            // Глагол, а не галочка. Одно имя метки в строке меню человек
            // читает как «повесить», и снятия он там просто не находит.
            label: t(on ? 'label.remove' : 'label.add', { name }),
            disabled: !settings.writable,
            run: () => setLabel(name, [node.id], !on),
          })
        }
        items.push({
          key: 'label:new',
          label: t('label.new'),
          disabled: !settings.writable,
          run: () => askLabel([node.id]),
        })
        items.push({ separator: true })
        items.push({
          key: 'archive',
          label: t('menu.archive'),
          danger: true,
          run: () => {
            // Единственное действие плагина с подтверждением: ядровый архив
            // необратим, метода возврата в API нет вовсе.
            if (window.confirm(t('confirm.archive'))) {
              props.archiveSession(node.id).catch((e) => {
                setError(t('error.archive', { message: (e && e.message) || String(e) }))
              })
            }
          },
        })
        setMenu({ at: at || { x: 120, y: 120 }, items })
      }

      const commitRename = async (id, title) => {
        setRenamingId(null)
        const next = String(title || '').trim()
        if (next === '') return
        try {
          await props.renameSession(id, next)
        } catch (e) {
          setError(t('error.rename', { message: (e && e.message) || String(e) }))
        }
      }

      // Архивную сессию открываем расшифровкой, а не в беседе: сделать её
      // текущей нельзя, ядро немедленно снимет выбор.
      const openRow = (id) => {
        if (archivedSet.has(id)) {
          const node = nodeOf(id)
          setViewing({ id, title: (node && node.title) || t('row.untitled') })
          return
        }
        props.open(id)
      }

      const pickRow = (id, withRange) => {
        const order = orderRef.current
        setSelected((prev) => {
          const set = new Set(prev)
          if (withRange && lastPicked.current !== null) {
            const from = order.indexOf(lastPicked.current)
            const to = order.indexOf(id)
            if (from !== -1 && to !== -1) {
              const [a, b] = from <= to ? [from, to] : [to, from]
              for (let i = a; i <= b; i += 1) set.add(order[i])
              lastPicked.current = id
              return [...set]
            }
          }
          if (set.has(id)) set.delete(id)
          else set.add(id)
          lastPicked.current = id
          return [...set]
        })
      }

      const renderRows = (rows) => rows.map((node) => {
        renderedRef.current.push(node.id)
        // Порядок подписи: сохранённое название, затем выведенное нами, затем
        // то, что даёт ядро (имя каталога или идентификатор).
        const shown = (!node.named && derived[node.id])
          ? Object.assign({}, node, { title: derived[node.id] })
          : node
        return h(SessionRow, {
          key: node.id,
          node: shown,
          t,
          current: node.id === currentId,
          pinned: pinnedSet.has(node.id),
          snippet: found === null ? undefined : found[node.id],
          selectable: true,
          selected: selectedSet.has(node.id),
          onSelect: pickRow,
          renaming: renamingId === node.id,
          onOpen: openRow,
          onMenu: openMenu,
          onRenameCommit: (value) => commitRename(node.id, value),
          onRenameCancel: () => setRenamingId(null),
        })
      })

      /**
       * Запросить подписи для строк, которые сейчас на экране.
       *
       * Эффект без списка зависимостей намеренно: интересует не значение, а
       * состав нарисованных строк, а он меняется от чего угодно — раскрытия
       * раздела, поиска, фильтра по метке. Повторов не будет: спрошенные
       * идентификаторы запоминаются до запроса.
       */
      React.useEffect(() => {
        const want = []
        for (const id of renderedRef.current) {
          if (askedRef.current.has(id)) continue
          const node = nodeOf(id)
          if (node === undefined || node.named || node.blank) continue
          want.push(id)
          if (want.length >= 60) break
        }
        if (want.length === 0) return undefined
        for (const id of want) askedRef.current.add(id)
        let dropped = false
        fetch('/dsh-session-control/titles?sessions=' + want.map(encodeURIComponent).join(','))
          .then((response) => response.json())
          .then((body) => {
            if (dropped || body.ok !== true) return
            setDerived((prev) => Object.assign({}, prev, body.titles))
          })
          .catch(() => { /* отказ маршрута оставляет подпись прежней */ })
        return () => { dropped = true }
      })

      // Полный список для окна быстрого перехода: там ищут и по архиву тоже.
      const jumpSessions = React.useMemo(
        () => Object.keys(sessionsById)
          .map(nodeOf)
          .filter((n) => n !== undefined)
          .map((n) => ({
            id: n.id,
            title: n.named ? n.title : (derived[n.id] || n.title),
            archived: archivedSet.has(n.id),
          })),
        [sessionsById, nodeOf, derived, archivedSet],
      )

      // Сочетание открывает и закрывает окно перехода. Ядро это сочетание не
      // занимает: в клиентских пакетах нет ни одного обработчика на него.
      React.useEffect(() => {
        const onKey = (e) => {
          if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault()
            setJumpOpen((v) => !v)
          }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [])

      const jumpTo = (id) => { setJumpOpen(false); openRow(id) }

      const quickJump = jumpOpen
        ? h(QuickJump, {
            t,
            sessions: jumpSessions,
            searchSessions: props.searchSessions,
            onPick: jumpTo,
            onClose: () => setJumpOpen(false),
          })
        : null

      // Узкая панель: ядро отдаёт нам ту же полосу, что и штатному блоку.
      if (props.wide === false) {
        return h(
          'div',
          { className: 'dsc-rail' },
          quickJump,
          viewing
            ? h(ArchiveViewer, { sessionId: viewing.id, title: viewing.title, t,
                                 onClose: () => setViewing(null) })
            : null,
          h('button', {
            type: 'button',
            className: 'dsc-rail-btn',
            'aria-label': t('head.search'),
            onClick: () => { props.expandSidebar(); setSearchOpen(true) },
          }, h(Search, {})),
          flowAvailable
            ? h('button', {
                type: 'button',
                className: 'dsc-rail-btn',
                'aria-label': t('head.add'),
                onClick: () => { props.expandSidebar(); setFlowOpen(true) },
              }, h(Add, {}))
            : null,
        )
      }

      // Список строк собирается заново на каждую отрисовку: он и есть ответ
      // на вопрос «что сейчас видно».
      renderedRef.current = []

      const loading = workspacePhase !== 'ready' || sessionPhase !== 'ready'
      // Под поиском и под фильтром по метке свёрнутые разделы раскрываются:
      // иначе найденное прячется за закрытым заголовком.
      const forced = query.trim() !== '' || labelFilter !== ''
      const nothing = !loading && groups.length === 0 && pinnedRows.length === 0

      return h(
        'div',
        { className: 'dsc-root' },
        h(
          'div',
          { className: 'dsc-head' },
          h('span', { className: 'dsc-head-title' }, t('head.title')),
          h('button', {
            type: 'button',
            className: 'dsc-icon-btn',
            'aria-label': t('head.search'),
            onClick: () => setSearchOpen((v) => !v),
          }, h(Search, {})),
          flowAvailable
            ? h('button', {
                type: 'button',
                className: 'dsc-icon-btn',
                'aria-label': t('head.add'),
                onClick: () => setFlowOpen(true),
              }, h(Add, {}))
            : null,
        ),
        searchOpen
          ? h('input', {
              className: 'dsc-search',
              value: query,
              placeholder: t('head.searchPlaceholder'),
              autoFocus: true,
              onChange: (e) => setQuery(e.currentTarget.value),
              onKeyDown: (e) => { if (e.key === 'Escape') { setQuery(''); setSearchOpen(false) } },
            })
          : null,
        labelNames.length > 0
          ? h('div', { className: 'dsc-chips' }, labelNames.map((name) => h('button', {
              key: name,
              type: 'button',
              className: 'dsc-chip' + (labelFilter === name ? ' dsc-chip-on' : ''),
              'aria-pressed': labelFilter === name ? 'true' : 'false',
              onClick: () => setLabelFilter(labelFilter === name ? '' : name),
            }, name + ' \u00b7 ' + (labels[name] || []).length)))
          : null,
        settings.status === 'unavailable'
          ? h('div', { className: 'dsc-error' }, t('error.settings'))
          : null,
        error !== '' ? h('div', { className: 'dsc-error' }, error) : null,
        searchFailed !== '' ? h('div', { className: 'dsc-error' }, searchFailed) : null,
        h(
          'div',
          { className: 'dsc-list' },
          loading
            ? h('div', null,
                h('div', { className: 'dsc-skeleton' }),
                h('div', { className: 'dsc-skeleton' }),
                h('div', { className: 'dsc-skeleton' }))
            : null,
          !loading && nothing
            ? h('div', { className: 'dsc-empty' }, t('empty.noWorkspaces'))
            : null,
          !loading && pinnedRows.length > 0
            ? h(Section, {
                id: 'pinned',
                name: t('section.pinned'),
                count: pinnedRows.length,
                collapsed: isCollapsed('pinned', false),
                defaultCollapsed: false,
                onToggle: toggleCollapsed,
              }, renderRows(pinnedRows))
            : null,
          !loading
            ? groups.map((g) => h(Section, {
                key: g.id,
                id: 'ws:' + g.id,
                name: g.title,
                count: g.rows.length,
                collapsed: isCollapsed('ws:' + g.id, false),
                defaultCollapsed: false,
                onToggle: toggleCollapsed,
              }, g.rows.length === 0
                  ? h('div', { className: 'dsc-empty' },
                      query.trim() === '' ? t('empty.workspace') : t('empty.search'))
                  : renderRows(g.rows)))
            : null,
          !loading && hiddenRows.length > 0
            ? h(Section, {
                id: 'hidden',
                name: t('section.hidden'),
                count: hiddenRows.length,
                collapsed: forced ? false : isCollapsed('hidden', true),
                defaultCollapsed: true,
                onToggle: toggleCollapsed,
              }, renderRows(hiddenRows))
            : null,
          !loading && archiveRows.length > 0
            ? h(Section, {
                id: 'archive',
                name: t('section.archive'),
                count: archiveRows.length,
                collapsed: forced ? false : isCollapsed('archive', true),
                defaultCollapsed: true,
                onToggle: toggleCollapsed,
              },
                h('div', { className: 'dsc-empty' }, t('section.archiveNote')),
                // Периоды: свёрнутый период не рисуется вовсе, поэтому сотни
                // строк перестают попадать в разметку разом.
                PERIODS.map((period) => {
                  const rows = archiveByPeriod[period]
                  if (rows.length === 0) return null
                  return h(Section, {
                    key: period,
                    id: 'archive:' + period,
                    name: t('period.' + period),
                    count: rows.length,
                    collapsed: forced ? false : isCollapsed('archive:' + period, period !== 'today'),
                    defaultCollapsed: period !== 'today',
                    onToggle: toggleCollapsed,
                  }, renderRows(rows))
                }))
            : null,
        ),
        selected.length > 0
          ? h('div', { className: 'dsc-bulk' },
              h('span', { className: 'dsc-bulk-count' }, t('bulk.count', { n: selected.length })),
              h('button', {
                type: 'button', className: 'dsc-bulk-act', disabled: !settings.writable,
                onClick: () => {
                  const next = settings.hidden.concat(selected.filter((id) => !hiddenSet.has(id)))
                  writeList('hidden', next); setSelected([])
                },
              }, t('bulk.hide')),
              h('button', {
                type: 'button', className: 'dsc-bulk-act', disabled: !settings.writable,
                onClick: () => {
                  writeList('hidden', settings.hidden.filter((id) => !selectedSet.has(id)))
                  setSelected([])
                },
              }, t('bulk.unhide')),
              h('button', {
                type: 'button', className: 'dsc-bulk-act', disabled: !settings.writable,
                onClick: () => {
                  const next = settings.pinned.concat(selected.filter((id) => !pinnedSet.has(id)))
                  writeList('pinned', next); setSelected([])
                },
              }, t('bulk.pin')),
              h('button', {
                type: 'button', className: 'dsc-bulk-act', disabled: !settings.writable,
                onClick: () => { askLabel(selected); setSelected([]) },
              }, t('bulk.label')),
              // Снятие пачкой имеет смысл только когда видно, с какой именно
              // метки снимаем, — то есть под её фильтром.
              labelFilter !== ''
                ? h('button', {
                    type: 'button', className: 'dsc-bulk-act', disabled: !settings.writable,
                    onClick: () => { setLabel(labelFilter, selected, false); setSelected([]) },
                  }, t('label.remove', { name: labelFilter }))
                : null,
              h('button', {
                type: 'button', className: 'dsc-bulk-act',
                onClick: () => { setSelected([]); lastPicked.current = null },
              }, t('bulk.clear')))
          : null,
        quickJump,
        menu ? h(RowMenu, { at: menu.at, items: menu.items, onClose: () => setMenu(null) }) : null,
        viewing
          ? h(ArchiveViewer, { sessionId: viewing.id, title: viewing.title, t,
                               onClose: () => setViewing(null) })
          : null,
        // Поток выбора каталога: мы владеем кнопкой и присвоением пути,
        // занявший слот владеет всем, что между открытием и выбранным путём.
        props.renderSlot('sidebar.workspaces.directoryFlow', {
          open: flowOpen,
          busy: flowBusy,
          onPicked: (path) => {
            setFlowBusy(true)
            props.createWorkspace({ path }).then(
              () => { setFlowBusy(false); setFlowOpen(false) },
              (e) => {
                setFlowBusy(false)
                setFlowOpen(false)
                setError(t('error.addWorkspace', { message: (e && e.message) || String(e) }))
              },
            )
          },
          onCancel: () => setFlowOpen(false),
          onError: (message) => { setFlowOpen(false); setError(message) },
        }),
      )
    }

    /**
     * Выбор папки на пустом экране беседы.
     *
     * Обязательство замены: ядровый ряд отдавал этот слот, и без него на
     * пустом экране не остаётся способа выбрать или завести папку.
     */
    function HeroWorkspacePicker(props) {
      const t = props.t
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const available = props.useDirectoryFlow((occupied) => occupied)

      React.useEffect(() => { ensureStyles() }, [])

      // Дочерний слот отрисовывается всегда, даже когда занять его некому:
      // так делает ядровый эталон. Условной отрисовкой мы бы создавали и
      // разрушали поддерево при каждой смене занятости, а слот объявлен
      // single/root — его занимает один компонент сразу на обе дырки.
      return h(
        'div',
        null,
        available
          ? h('button', {
              type: 'button',
              className: 'dsc-menu-item',
              disabled: busy,
              onClick: () => setOpen(true),
            }, t('head.add'))
          : null,
        error !== '' ? h('div', { className: 'dsc-error' }, error) : null,
        props.renderSlot('conversation.hero.workspace.directoryFlow', {
          open,
          busy,
          onPicked: (path) => {
            setBusy(true)
            props.createWorkspace({ path }).then(
              () => { setBusy(false); setOpen(false) },
              (e) => {
                setBusy(false)
                setOpen(false)
                setError(t('error.addWorkspace', { message: (e && e.message) || String(e) }))
              },
            )
          },
          onCancel: () => setOpen(false),
          onError: (message) => { setOpen(false); setError(message) },
        }),
      )
    }

    /** Карточка в «Настройки → Плагины → Настройки плагинов». */
    function SettingsCard(props) {
      const t = props.t
      const ctx = props.ctx
      const [open, setOpen] = React.useState(false)
      const scope = React.useMemo(
        () => (ctx && ctx.settingsScope ? ctx.settingsScope.bind({ namespace: NS }) : undefined),
        [ctx],
      )
      const settings = useSettings(scope)
      React.useEffect(() => { ensureStyles() }, [])

      const body = settings.status === 'loading'
        ? h('div', { className: 'dsc-card-stat' }, t('card.loading'))
        : settings.status !== 'ready'
          ? h('div', { className: 'dsc-error' }, t('error.settings'))
          : h('div', null,
              h('div', { className: 'dsc-card-stat' },
                t('card.pinnedCount', { n: settings.pinned.length }) + ' · ' +
                t('card.hiddenCount', { n: settings.hidden.length }) + ' · ' +
                t('card.labelsCount', { n: Object.keys(settings.labels).length })),
              h('label', { className: 'dsc-card-toggle' },
                h('input', {
                  type: 'checkbox',
                  checked: settings.hideBlank,
                  onChange: (e) => { if (scope) scope.set('hideBlank', e.currentTarget.checked) },
                }),
                h('span', null, t('card.hideBlank'))),
              h('button', {
                type: 'button',
                className: 'dsc-card-action',
                disabled: settings.hidden.length === 0,
                onClick: () => { if (scope) scope.set('hidden', []) },
              }, t('card.unhideAll')))

      return h(
        'li',
        { className: 'dsc-card' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsc-card-head',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => setOpen((v) => !v),
          },
          h('span', { className: 'dsc-card-text' },
            h('span', { className: 'dsc-card-title' }, t('card.title')),
            h('span', { className: 'dsc-card-sub' }, t('card.subtitle'))),
          h(Chevron, { className: 'dsc-card-chev' + (open ? ' dsc-card-chev-open' : '') }),
        ),
        open ? h('div', { className: 'dsc-card-body' }, body) : null,
      )
    }

    /** Пространство настроек. Совпадает с ключом карточки. */
    const NS = 'dsh-session-control'

    const en = {
      'head.title': 'Conversations',
      'head.search': 'Search',
      'head.searchPlaceholder': 'Title or message text',
      'head.add': 'Add workspace…',
      'period.today': 'Today',
      'period.week': 'This week',
      'period.month': 'This month',
      'period.older': 'Earlier',
      'bulk.select': 'Select session',
      'bulk.count': 'selected: {n}',
      'bulk.hide': 'Hide',
      'bulk.unhide': 'Unhide',
      'bulk.pin': 'Pin',
      'bulk.label': 'Label…',
      'bulk.clear': 'Clear',
      'label.add': 'Add to \u201c{name}\u201d',
      'label.remove': 'Remove from \u201c{name}\u201d',
      'label.new': 'New label…',
      'label.prompt': 'Label name',
      'jump.title': 'Go to conversation',
      'jump.placeholder': 'Title or message text',
      'jump.empty': 'Nothing found.',
      'jump.archived': 'archived',
      'jump.hint': 'Ctrl+K to open · arrows to move · Enter to open · Esc to close',
      'section.pinned': 'Pinned',
      'section.hidden': 'Hidden',
      'section.archive': 'Archived',
      'section.archiveNote': 'Archived by the core: open to read, restoring is not possible yet.',
      'row.blank': 'New session',
      'row.untitled': 'Untitled',
      'row.running': 'Running',
      'row.menu': 'Session actions',
      'menu.pin': 'Pin',
      'menu.unpin': 'Unpin',
      'menu.rename': 'Rename',
      'menu.fork': 'Fork session',
      'menu.hide': 'Hide',
      'menu.unhide': 'Unhide',
      'menu.archive': 'Archive (permanent)',
      'confirm.archive': 'Archiving is permanent: the core has no way to restore a session. Continue?',
      'empty.noWorkspaces': 'No workspaces yet. Add one to start a conversation.',
      'empty.workspace': 'No conversations here yet.',
      'empty.search': 'Nothing found.',
      'error.search': 'Search failed: {message}',
      'error.settings': 'Settings are unavailable, so pinning and hiding are off. The list still works.',
      'error.save': 'Could not save: {message}',
      'error.rename': 'Could not rename: {message}',
      'error.archive': 'Could not archive: {message}',
      'error.addWorkspace': 'Could not add workspace: {message}',
      'age.now': 'now',
      'age.min': '{n} min',
      'age.hour': '{n} h',
      'age.day': '{n} d',
      'viewer.readonly': 'read-only',
      'viewer.close': 'Close',
      'viewer.you': 'You',
      'viewer.agent': 'Agent',
      'viewer.tool': 'tool: {name}',
      'viewer.loading': 'Loading the transcript…',
      'viewer.empty': 'This session has no messages.',
      'viewer.unreadable': 'An older log format the core declines to read. The conversation is intact on disk, but cannot be shown here.',
      'viewer.truncated': 'Showing the last {shown} of {total} messages.',
      'viewer.failed': 'Could not read the session: {message}',
      'viewer.copy': 'Copy as Markdown',
      'viewer.save': 'Save .md',
      'viewer.copied': 'Copied to the clipboard.',
      'viewer.noClipboard': 'the clipboard is unavailable in this browser context',
      'viewer.exportFailed': 'Could not export: {message}',
      'card.title': 'Session control',
      'card.subtitle': 'Pinned, labelled and hidden conversations in the sidebar list.',
      'card.loading': 'Loading…',
      'card.pinnedCount': 'pinned: {n}',
      'card.hiddenCount': 'hidden: {n}',
      'card.labelsCount': 'labels: {n}',
      'card.hideBlank': 'Hide sessions with no messages',
      'card.unhideAll': 'Unhide all',
    }


    // Половине «сервис» нужен минимум: чем короче этот список, тем меньше
    // причин, по которым приложение может не подняться.
    exports.inject = ['slots', 'sessions', 'workspaces', 'remote', 'remote.directoryPicker']

    exports.apply = function apply(ctx) {
      const sessions = ctx.get('sessions')
      const workspaces = ctx.get('workspaces')

      // ---- половина «СЕРВИС» ----
      new UiWorkspaceService(ctx, ctx.remote.directoryPicker, workspaces, sessions)
      ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })

      // ---- половина «ИНТЕРФЕЙС» ----
      // Отдельный дочерний контекст: если locale или settingsScope в сборке
      // нет, без интерфейса останется только слот, а сервис уже отдан.
      ctx.inject(['locale', 'settingsScope'], (uictx) => {
        try {
          // Словари регистрируем в собственной защите и НИКОГДА не даём им
          // утащить за собой интерфейс.
          //
          // Клиентское дерево применяется дважды за загрузку страницы.
          // Повторная регистрация того же пространства бросает «already has
          // locale», и если этот вызов стоит первым в общем try, вместе с ним
          // не регистрируется ни список, ни выбор папки, ни карточка настроек:
          // приложение живо, а тело панели пустое. Ровно это и случилось на
          // production. Цена отказа здесь — подписи на английском, а не
          // отсутствие панели.
          // Плагин везёт только английский. Русский для наших плагинов
          // поставляет отдельный языковой плагин, и он занимает то же
          // пространство настроек. Регистрация под защитой: если он успел
          // раньше, повторная попытка бросает, а уронить вместе с собой весь
          // интерфейс словари не имеют права — именно так панель и пропала на
          // production.
          try {
            uictx.effect(
              () => uictx.locale.register(NS, { en }),
              'dsh-session-control: словарь en',
            )
          } catch (taken) {
            console.warn('[dsh-session-control] словарь уже зарегистрирован:',
              (taken && taken.message) || taken)
          }

          const searchSessions = async (query, signal) => {
            const result = await sessions.search(query, signal)
            if (!result.ok) throw new Error(result.error.message)
            return result.value
          }

          // Занятость дочернего слота: источник должен быть стабильным,
          // отрисовщик кэширует хуки по тождеству источника.
          const flowSource = (hole) => ({
            getSnapshot: () => uictx.slots.entries(hole).length > 0,
            subscribe: (listener) => uictx.slots.subscribe(hole, listener),
          })
          const browserFlow = flowSource('sidebar.workspaces.directoryFlow')
          const pickerFlow = flowSource('conversation.hero.workspace.directoryFlow')
          const hostInfo = {
            getSnapshot: () => uictx.remote.$host,
            subscribe: (listener) => uictx.on('connection/reset', listener),
          }
          const settingsScope = uictx.settingsScope.bind({ namespace: NS })

          const browserInjected = () => ({
            settingsScope,
            startSession: (workspaceId) => { uictx.get('uiWorkspace').startSession(workspaceId) },
            open: (sessionId) => { sessions.open(sessionId) },
            searchSessions,
            searchResultLimit: sessions.searchResultLimit,
            renameSession: async (sessionId, title) => {
              const session = sessions.binding(sessionId)?.session
              if (session === undefined) throw new Error(`unknown session "${sessionId}"`)
              const result = await session.rename(title)
              if (!result.ok) throw new Error(result.error.message)
            },
            forkSession: (sessionId) => {
              sessions.fork({ sessionId, increaseTitle: true })
                .then((childId) => { sessions.open(childId) })
                .catch(() => { /* отказ ответвления сохраняет текущий выбор */ })
            },
            archiveSession: async (sessionId) => { await workspaces.archiveSession(sessionId) },
            createWorkspace: (input) => workspaces.create(input),
            hooks: { directoryFlow: browserFlow, hostInfo },
          })

          const pickerInjected = () => ({
            createWorkspace: (input) => workspaces.create(input),
            hooks: { directoryFlow: pickerFlow },
          })

          uictx.slots.inject('sidebar.workspaces', () => uictx.slots.register(
            {
              name: 'sidebar.workspaces',
              children: { 'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' } },
              inject: browserInjected,
              locale: NS,
            },
            SessionListPanel,
          ))

          uictx.slots.inject('conversation.hero.workspace', () => uictx.slots.register(
            {
              name: 'conversation.hero.workspace',
              children: { 'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' } },
              inject: pickerInjected,
              locale: NS,
            },
            HeroWorkspacePicker,
          ))

          uictx.slots.inject('settings.plugin.item', () => uictx.slots.register(
            {
              name: 'settings.plugin.item',
              key: NS,
              locale: NS,
              inject: () => ({ ctx: uictx }),
            },
            SettingsCard,
          ))
        } catch (uiFailed) {
          // Слот останется пустым, приложение — живым. Молчать нельзя:
          // именно молчаливый catch уже дал нам два невидимых дефекта.
          console.error('[dsh-session-control] интерфейс не поднялся:', uiFailed)
        }
      })
    }

    return module.exports
  },
})
