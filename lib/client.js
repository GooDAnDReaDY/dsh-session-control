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
        ctx.effect(() => this.watchNavigation(), 'dsh-session-control: folder navigation policy')
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
            console.warn('[dsh-session-control] failed to start session:', reason)
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
              console.warn('[dsh-session-control] failed to open last folder:', reason)
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
      style.dataset.dshPlugin = 'dsh-session-control'
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
.dsc-bulk-danger { color:var(--dsw-alias-state-error-primary) }
.dsc-turns-badge { flex:none; font-size:10px; padding:1px 5px; border-radius:999px;
  background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums; line-height:1.2 }
.dsc-jump-filters { display:flex; gap:6px; padding:10px 16px 6px; border-bottom:1px solid var(--dsw-alias-border-l2) }
.dsc-jump-chip { appearance:none; font:inherit; font-size:12px; cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2); border-radius:999px; padding:3px 10px;
  background:0 0; color:var(--dsw-alias-label-secondary); transition:all .12s ease }
.dsc-jump-chip:hover { background:var(--dsw-alias-interactive-bg-hover) }
.dsc-jump-chip-active { color:var(--dsw-alias-label-primary);
  border-color:var(--dsw-alias-state-business-primary); background:var(--dsw-alias-interactive-bg-hover) }
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
.dsc-size { flex:none; font-size:10px; line-height:1.4; padding:0 5px; border-radius:999px;
  border:1px solid currentColor; font-variant-numeric:tabular-nums }
.dsc-size-warn { color:var(--dsw-alias-state-warn-primary) }
.dsc-size-danger { color:var(--dsw-alias-state-error-primary); font-weight:600 }
.dsc-status { padding:4px 6px; color:var(--dsw-alias-label-secondary); font-size:12px }
.dsc-card-group { margin-top:14px; display:flex; flex-direction:column; gap:8px }
.dsc-card-group-title { color:var(--dsw-alias-label-primary); font-size:13px; font-weight:600 }
.dsc-card-hint { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.5 }
.dsc-card-field { display:flex; flex-direction:column; gap:4px }
.dsc-card-label { color:var(--dsw-alias-label-secondary); font-size:12px }
.dsc-card-input { height:30px; box-sizing:border-box; border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-primary);
  border-radius:8px; padding:0 10px; font:inherit; font-size:13px; max-width:260px }
.dsc-card-input[aria-invalid="true"] { border-color:var(--dsw-alias-state-error-primary) }
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
        // #39: size badge thresholds; the server normalizes them, so any number is safe here.
        sizeWarnEvents: typeof value.sizeWarnEvents === 'number' ? value.sizeWarnEvents : 1500,
        sizeDangerEvents: typeof value.sizeDangerEvents === 'number' ? value.sizeDangerEvents : 3000,
        // #41: model summary route; empty provider or model disables it.
        handoffProvider: typeof value.handoffProvider === 'string' ? value.handoffProvider : '',
        handoffModel: typeof value.handoffModel === 'string' ? value.handoffModel : '',
        handoffMaxInputChars: typeof value.handoffMaxInputChars === 'number' ? value.handoffMaxInputChars : 60000,
        handoffTimeoutSeconds: typeof value.handoffTimeoutSeconds === 'number' ? value.handoffTimeoutSeconds : 90,
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
    function SessionRow({ node, current, pinned, snippet, size, selected, selectable, onSelect, t, onOpen, onMenu, renaming, onRenameCommit, onRenameCancel }) {
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
        // #39: size badge. Text plus colour, so the meaning does not rely on colour alone.
        size && (size.level === 'warn' || size.level === 'danger') && typeof size.events === 'number'
          ? h('span', {
              className: 'dsc-size dsc-size-' + size.level,
              role: 'img',
              'aria-label': t('size.' + size.level, { n: size.events }),
              title: t('size.tooltip', { n: size.events, size: formatBytes(size.bytes) }),
            }, formatCount(size.events))
          : null,
        node.turnsCount > 0
          ? h('span', { className: 'dsc-turns-badge', title: t('row.turns', { n: node.turnsCount }) }, node.turnsCount)
          : null,
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
      const [filter, setFilter] = React.useState('all')
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

      const filteredSessions = React.useMemo(() => {
        if (filter === 'pinned') return sessions.filter((s) => s.pinned)
        if (filter === 'tags') return sessions.filter((s) => s.hasTags)
        if (filter === 'archived') return sessions.filter((s) => s.archived)
        return sessions
      }, [sessions, filter])

      const rows = React.useMemo(() => {
        const text = query.trim().toLowerCase()
        const out = []
        const seen = new Set()
        for (const s of filteredSessions) {
          if (text !== '' && !s.title.toLowerCase().includes(text)) continue
          seen.add(s.id)
          out.push({ id: s.id, title: s.title, archived: s.archived, snippet: '' })
          if (out.length >= 30) break
        }
        if (remote !== null) {
          for (const s of filteredSessions) {
            if (seen.has(s.id)) continue
            if (!Object.prototype.hasOwnProperty.call(remote, s.id)) continue
            out.push({ id: s.id, title: s.title, archived: s.archived, snippet: remote[s.id] })
            if (out.length >= 60) break
          }
        }
        return out
      }, [filteredSessions, query, remote])

      React.useEffect(() => { setCursor(0) }, [query, filter, remote])

      const move = (step) => {
        if (rows.length === 0) return
        setCursor((prev) => (prev + step + rows.length) % rows.length)
      }

      const filters = [
        { id: 'all', label: t('jump.filterAll') },
        { id: 'pinned', label: t('jump.filterPinned') },
        { id: 'tags', label: t('jump.filterTags') },
        { id: 'archived', label: t('jump.filterArchived') },
      ]

      return h(
        'div',
        { className: 'dsc-jump', role: 'dialog', 'aria-modal': 'true',
          onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
        h(
          'div',
          { className: 'dsc-jump-box' },
          h('div', { className: 'dsc-jump-filters' },
            filters.map((item) => h('button', {
              key: item.id,
              type: 'button',
              className: 'dsc-jump-chip' + (filter === item.id ? ' dsc-jump-chip-active' : ''),
              onClick: () => setFilter(item.id),
            }, item.label))
          ),
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
      // #39: sizes of rows on screen, asked once per row like derived titles.
      const [sizes, setSizes] = React.useState({})
      const sizeAskedRef = React.useRef(new Set())
      // #40/#41: session id currently being handed off, or null.
      const [handoffBusy, setHandoffBusy] = React.useState(null)
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
        const turnsCount = Array.isArray(s.events)
          ? s.events.filter((ev) => (ev && ev.type === 'message' && ev.data && ev.data.role === 'user')).length
          : (typeof s.messageCount === 'number' ? Math.max(0, Math.ceil(s.messageCount / 2)) : 0)
        return {
          id,
          title: s.blank ? '' : (s.displayTitle || s.title || ''),
          // Сохранённое название ставит человек переименованием, и оно всегда
          // главнее выведенного нами.
          named: typeof s.title === 'string' && s.title !== '',
          blank: s.blank === true,
          running: s.running === true,
          updatedAt: s.updatedAt || 0,
          turnsCount,
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
          { key: 'forkClean', label: t('menu.forkClean'), run: () => props.forkCleanSession(node.id) },
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
        const modelReady = settings.handoffProvider.trim() !== '' && settings.handoffModel.trim() !== ''
        items.push({
          key: 'handoff',
          label: t('menu.handoff'),
          disabled: handoffBusy !== null,
          run: () => { continueInNewSession(node, 'extract') },
        })
        items.push({
          key: 'handoffModel',
          label: modelReady ? t('menu.handoffModel') : t('menu.handoffModelOff'),
          disabled: handoffBusy !== null || !modelReady,
          run: () => { continueInNewSession(node, 'summary') },
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
          size: sizes[node.id],
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
          .catch(() => { /* route failure keeps existing title */ })
        return () => { dropped = true }
      })

      // Levels are computed on the host from the live thresholds; when the
      // thresholds change, ask again instead of showing stale colours.
      React.useEffect(() => {
        sizeAskedRef.current = new Set()
        setSizes({})
      }, [settings.sizeWarnEvents, settings.sizeDangerEvents])

      /** Ask sizes for rows on screen; same one-shot pattern as derived titles. */
      React.useEffect(() => {
        const want = []
        for (const id of renderedRef.current) {
          if (sizeAskedRef.current.has(id)) continue
          want.push(id)
          if (want.length >= 60) break
        }
        if (want.length === 0) return undefined
        for (const id of want) sizeAskedRef.current.add(id)
        let dropped = false
        fetch('/dsh-session-control/sizes?sessions=' + want.map(encodeURIComponent).join(','))
          .then((response) => response.json())
          .then((body) => {
            if (dropped || body.ok !== true) return
            setSizes((prev) => Object.assign({}, prev, body.sizes))
          })
          .catch(() => { /* no badge when sizes are unavailable */ })
        return () => { dropped = true }
      })

      /**
       * Continue in a new session (#40, #41).
       *
       * Builds the handoff text on the host, creates a new session in the same
       * workspace, parks the text for the composer dock and opens the session.
       * Nothing is sent: the person reviews and sends the draft.
       * @param node - row of the session to leave.
       * @param mode - 'extract' (instant, no model) or 'summary' (model-written).
       */
      const continueInNewSession = async (node, mode) => {
        if (handoffBusy) return
        setError('')
        setHandoffBusy(node.id)
        try {
          const summary = sessionsById[node.id] || {}
          const cwd = summary.cwd || ''
          const title = node.title || ''
          const workspace = (workspaces || []).find((w) => (w.sessionIds || []).includes(node.id))
            || (workspaces || []).find((w) => cwd && w.path === cwd)
          if (!workspace) throw new Error(t('error.handoffNoWorkspace'))

          let response
          if (mode === 'summary') {
            response = await fetch('/dsh-session-control/handoff-summary', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: node.id, title, cwd }),
            })
          } else {
            response = await fetch('/dsh-session-control/handoff?session=' + encodeURIComponent(node.id)
              + '&title=' + encodeURIComponent(title) + '&cwd=' + encodeURIComponent(cwd))
          }
          const body = await response.json().catch(() => ({}))
          if (!response.ok || body.ok !== true || typeof body.text !== 'string') {
            throw new Error(body.error || ('HTTP ' + response.status))
          }

          const newId = await props.createSession(workspace.workspaceId)
          if (!newId) throw new Error('the new session was not created')
          parkDraft(newId, body.text)
          props.open(newId)
        } catch (failed) {
          setError(t('error.handoff', { message: (failed && failed.message) || String(failed) }))
        } finally {
          setHandoffBusy(null)
        }
      }

      // Полный список для окна быстрого перехода: там ищут и по архиву тоже.
      const jumpSessions = React.useMemo(
        () => Object.keys(sessionsById)
          .map(nodeOf)
          .filter((n) => n !== undefined)
          .map((n) => {
            const hasTags = labelNames.some((lbl) => Array.isArray(labels[lbl]) && labels[lbl].includes(n.id))
            return {
              id: n.id,
              title: n.named ? n.title : (derived[n.id] || n.title),
              archived: archivedSet.has(n.id),
              pinned: pinnedSet.has(n.id),
              hasTags,
            }
          }),
        [sessionsById, nodeOf, derived, archivedSet, pinnedSet, labelNames, labels],
      )

      /**
       * Сочетание открывает и закрывает окно перехода.
       *
       * Alt, а не Ctrl: Ctrl+K браузер оставляет за собой (адресная строка в
       * Chrome, строка поиска в Firefox) и странице его не отдаёт — проверено
       * на production, окно не открывалось вовсе. Alt+K свободен и в ядре, и у
       * соседних плагинов, которые заняли Alt+S и Alt+стрелки.
       *
       * Букву сверяем и по кириллической раскладке: при русской раскладке
       * браузер сообщает `л`, и без этого сочетание молча переставало работать
       * ровно у того, для кого делалось.
       */
      React.useEffect(() => {
        const onKey = (e) => {
          if (!e.altKey || e.ctrlKey || e.metaKey) return
          const key = String(e.key).toLowerCase()
          if (key !== 'k' && key !== '\u043b') return
          e.preventDefault()
          setJumpOpen((v) => !v)
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
        handoffBusy !== null ? h('div', { className: 'dsc-status', role: 'status' }, t('handoff.busy')) : null,
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
                onClick: () => {
                  window.open('/dsh-session-control/export-batch?sessions=' + selected.map(encodeURIComponent).join(','), '_blank')
                },
              }, t('bulk.export')),
              h('button', {
                type: 'button', className: 'dsc-bulk-act dsc-bulk-danger',
                onClick: () => {
                  if (window.confirm(t('confirm.archiveBulk', { n: selected.length }))) {
                    const toArchive = [...selected]
                    setSelected([])
                    Promise.all(toArchive.map((id) => props.archiveSession(id))).catch((e) => {
                      setError(t('error.archive', { message: (e && e.message) || String(e) }))
                    })
                  }
                },
              }, t('bulk.archive')),
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
    /**
     * Human-readable byte size.
     * @param bytes - size in bytes.
     * @returns short text such as "9.4 MB".
     */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return ''
      if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
      if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
      return bytes + ' B'
    }

    /**
     * Compact event count for a narrow badge: 842, 1.5k, 12k.
     * @param n - event count.
     * @returns short text.
     */
    function formatCount(n) {
      if (n >= 10000) return Math.round(n / 1000) + 'k'
      if (n >= 1000) return (Math.round(n / 100) / 10) + 'k'
      return String(n)
    }

    /**
     * Drafts waiting for a freshly created session to mount (#40).
     *
     * The sidebar lives in root scope, while `setDraft` exists only on the
     * input actions of one session, which a root component cannot reach. The
     * sidebar parks the draft here keyed by the new session id; the dock
     * component inside that session picks it up once. The store lives on
     * `window` because the client tree is applied twice per page load, and a
     * closure variable could end up split between the two copies.
     */
    const PENDING_KEY = '__dshSessionControlPendingDrafts'
    const PENDING_TTL_MS = 120000
    function pendingDrafts() {
      if (!window[PENDING_KEY]) window[PENDING_KEY] = { map: new Map(), listeners: new Set() }
      return window[PENDING_KEY]
    }
    function parkDraft(sessionId, text) {
      const store = pendingDrafts()
      store.map.set(sessionId, { text, at: Date.now() })
      for (const listener of [...store.listeners]) {
        try { listener() } catch (failed) { console.error('[dsh-session-control] draft listener failed:', failed) }
      }
    }

    /**
     * Invisible entry in `conversation.input.dock` that places a parked draft
     * into this session's composer exactly once. Never sends anything.
     */
    function HandoffDock(props) {
      const sessionId = props && props.session ? props.session.sessionId : undefined
      const actions = props ? props.inputActions : undefined
      React.useEffect(() => {
        if (!sessionId || !actions || typeof actions.setDraft !== 'function') return undefined
        const store = pendingDrafts()
        let timer = null
        const take = () => {
          const entry = store.map.get(sessionId)
          if (!entry) return
          if (Date.now() - entry.at > PENDING_TTL_MS) { store.map.delete(sessionId); return }
          // A short delay lets the composer finish restoring its own persisted
          // draft first; otherwise that restore would overwrite ours.
          clearTimeout(timer)
          timer = setTimeout(() => {
            const current = store.map.get(sessionId)
            if (!current) return
            store.map.delete(sessionId)
            try {
              actions.setDraft(current.text)
            } catch (failed) {
              console.error('[dsh-session-control] could not place the handoff draft:', failed)
            }
          }, 300)
        }
        take()
        store.listeners.add(take)
        return () => { store.listeners.delete(take); clearTimeout(timer) }
      }, [sessionId, actions])
      return null
    }

    /**
     * Number setting that saves on blur and refuses anything but a positive whole number.
     */
    function NumberSetting({ label, value, disabled, onSave, t }) {
      const [draft, setDraft] = React.useState(String(value))
      React.useEffect(() => { setDraft(String(value)) }, [value])
      const n = Number(draft)
      const invalid = !(Number.isInteger(n) && n > 0)
      return h('label', { className: 'dsc-card-field' },
        h('span', { className: 'dsc-card-label' }, label),
        h('input', {
          className: 'dsc-card-input',
          type: 'number',
          min: 1,
          step: 1,
          value: draft,
          disabled,
          'aria-invalid': invalid ? 'true' : 'false',
          onChange: (e) => setDraft(e.currentTarget.value),
          onBlur: () => { if (!invalid && n !== value) onSave(n) },
        }),
        invalid ? h('span', { className: 'dsc-error' }, t('card.invalidNumber')) : null)
    }

    /** Text setting that saves trimmed on blur. */
    function TextSetting({ label, value, placeholder, disabled, onSave }) {
      const [draft, setDraft] = React.useState(value)
      React.useEffect(() => { setDraft(value) }, [value])
      return h('label', { className: 'dsc-card-field' },
        h('span', { className: 'dsc-card-label' }, label),
        h('input', {
          className: 'dsc-card-input',
          type: 'text',
          value: draft,
          placeholder,
          disabled,
          spellCheck: false,
          onChange: (e) => setDraft(e.currentTarget.value),
          onBlur: () => { const next = draft.trim(); if (next !== value) onSave(next) },
        }))
    }

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
              }, t('card.unhideAll')),
              h('div', { className: 'dsc-card-group' },
                h('span', { className: 'dsc-card-group-title' }, t('card.sizeTitle')),
                h('span', { className: 'dsc-card-hint' }, t('card.sizeHint')),
                h(NumberSetting, {
                  t, label: t('card.sizeWarn'), value: settings.sizeWarnEvents, disabled: !settings.writable,
                  onSave: (n) => { if (scope) scope.set('sizeWarnEvents', n) },
                }),
                h(NumberSetting, {
                  t, label: t('card.sizeDanger'), value: settings.sizeDangerEvents, disabled: !settings.writable,
                  onSave: (n) => { if (scope) scope.set('sizeDangerEvents', n) },
                })),
              h('div', { className: 'dsc-card-group' },
                h('span', { className: 'dsc-card-group-title' }, t('card.handoffTitle')),
                h('span', { className: 'dsc-card-hint' }, t('card.handoffHint')),
                h(TextSetting, {
                  label: t('card.handoffProvider'), value: settings.handoffProvider, placeholder: 'provider-id',
                  disabled: !settings.writable, onSave: (v) => { if (scope) scope.set('handoffProvider', v) },
                }),
                h(TextSetting, {
                  label: t('card.handoffModel'), value: settings.handoffModel, placeholder: 'model-id',
                  disabled: !settings.writable, onSave: (v) => { if (scope) scope.set('handoffModel', v) },
                }),
                h(NumberSetting, {
                  t, label: t('card.handoffMaxInput'), value: settings.handoffMaxInputChars, disabled: !settings.writable,
                  onSave: (n) => { if (scope) scope.set('handoffMaxInputChars', n) },
                }),
                h(NumberSetting, {
                  t, label: t('card.handoffTimeout'), value: settings.handoffTimeoutSeconds, disabled: !settings.writable,
                  onSave: (n) => { if (scope) scope.set('handoffTimeoutSeconds', n) },
                })))

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
      'bulk.archive': 'Archive',
      'bulk.export': 'Export Markdown',
      'bulk.clear': 'Clear',
      'confirm.archiveBulk': 'Archive {n} sessions permanently? Restoring is not supported.',
      'label.add': 'Add to \u201c{name}\u201d',
      'label.remove': 'Remove from \u201c{name}\u201d',
      'label.new': 'New label…',
      'label.prompt': 'Label name',
      'jump.title': 'Go to conversation',
      'jump.placeholder': 'Title or message text',
      'jump.empty': 'Nothing found.',
      'jump.archived': 'archived',
      'jump.hint': 'Alt+K to open · arrows to move · Enter to open · Esc to close',
      'jump.filterAll': 'All',
      'jump.filterPinned': 'Pinned',
      'jump.filterTags': 'Tags',
      'jump.filterArchived': 'Archived',
      'section.pinned': 'Pinned',
      'section.hidden': 'Hidden',
      'section.archive': 'Archived',
      'section.archiveNote': 'Archived by the core: open to read, restoring is not possible yet.',
      'row.blank': 'New session',
      'row.untitled': 'Untitled',
      'row.running': 'Running',
      'row.menu': 'Session actions',
      'row.turns': '{n} turns',
      'menu.pin': 'Pin',
      'menu.unpin': 'Unpin',
      'menu.rename': 'Rename',
      'menu.fork': 'Fork session',
      'menu.forkClean': 'New session with same settings',
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
      'size.warn': 'Large session: {n} events',
      'size.danger': 'Session too large for the interface: {n} events',
      'size.tooltip': '{n} events, {size}. Continue in a new session to keep the interface responsive.',
      'menu.handoff': 'Continue in new session',
      'menu.handoffModel': 'Continue with a model summary',
      'menu.handoffModelOff': 'Continue with a model summary (set a model in settings)',
      'handoff.busy': 'Preparing the new session…',
      'error.handoff': 'Could not continue in a new session: {message}',
      'error.handoffNoWorkspace': 'this session has no workspace to continue in',
      'card.sizeTitle': 'Session size',
      'card.sizeHint': 'Very large sessions can freeze the browser tab during long agent turns. Rows show a yellow badge, then a red one.',
      'card.sizeWarn': 'Yellow badge from, events',
      'card.sizeDanger': 'Red badge from, events',
      'card.handoffTitle': 'Model summary for "Continue in new session"',
      'card.handoffHint': 'Leave provider or model empty to use only the instant extract, which needs no model.',
      'card.handoffProvider': 'Provider id',
      'card.handoffModel': 'Model id',
      'card.handoffMaxInput': 'Transcript budget, characters',
      'card.handoffTimeout': 'Timeout, seconds',
      'card.invalidNumber': 'Enter a whole number greater than zero.',
    }

    const zh = {
      'head.title': '\u4f1a\u8bdd\u5217\u8868',
      'head.search': '\u641c\u7d22',
      'head.searchPlaceholder': '\u6807\u9898\u6216\u6d88\u606f\u5185\u5bb9',
      'head.add': '\u6dfb\u52a0\u5de5\u4f5c\u533a\u2026',
      'period.today': '\u4eca\u5929',
      'period.week': '\u672c\u5468',
      'period.month': '\u672c\u6708',
      'period.older': '\u66f4\u65e9',
      'bulk.select': '\u9009\u62e9\u4f1a\u8bdd',
      'bulk.count': '\u5df2\u9009: {n}',
      'bulk.hide': '\u9690\u85cf',
      'bulk.unhide': '\u53d6\u6d88\u9690\u85cf',
      'bulk.pin': '\u7f6e\u9876',
      'bulk.label': '\u6807\u7b7e\u2026',
      'bulk.archive': '\u5f52\u6863',
      'bulk.export': '\u5bfc\u51fa Markdown',
      'bulk.clear': '\u6e05\u9664\u9009\u62e9',
      'confirm.archiveBulk': '\u6c38\u4e45\u5f52\u6863 {n} \u4e2a\u4f1a\u8bdd\uff1f\u65e0\u6cd5\u6062\u590d\u3002',
      'label.add': '\u6dfb\u52a0\u5230\u201c{name}\u201d',
      'label.remove': '\u4ece\u201c{name}\u201d\u79fb\u9664',
      'label.new': '\u65b0\u5efa\u6807\u7b7e\u2026',
      'label.prompt': '\u6807\u7b7e\u540d\u79f0',
      'jump.title': '\u8df3\u8f6c\u5230\u4f1a\u8bdd',
      'jump.placeholder': '\u6807\u9898\u6216\u6d88\u606f\u5185\u5bb9',
      'jump.empty': '\u672a\u627e\u5230\u76f8\u5173\u5185\u5bb9\u3002',
      'jump.archived': '\u5df2\u5f52\u6863',
      'jump.hint': 'Alt+K \u6253\u5f00 \u00b7 \u65b9\u5411\u952e\u79fb\u52a8 \u00b7 Enter \u6253\u5f00 \u00b7 Esc \u5173\u95ed',
      'jump.filterAll': '\u5168\u90e8',
      'jump.filterPinned': '\u7f6e\u9876',
      'jump.filterTags': '\u6807\u7b7e',
      'jump.filterArchived': '\u5df2\u5f52\u6863',
      'section.pinned': '\u7f6e\u9876\u4f1a\u8bdd',
      'section.hidden': '\u9690\u85cf\u4f1a\u8bdd',
      'section.archive': '\u5df2\u5f52\u6863',
      'section.archiveNote': '\u7cfb\u7edf\u5f52\u6863\u4f1a\u8bdd\uff1a\u4ec5\u4f9b\u9605\u8bfb\uff0c\u6682\u4e0d\u652f\u6301\u6062\u590d\u3002',
      'row.blank': '\u65b0\u4f1a\u8bdd',
      'row.untitled': '\u65e0\u6807\u9898',
      'row.running': '\u8fd0\u884c\u4e2d',
      'row.menu': '\u4f1a\u8bdd\u64cd\u4f5c',
      'row.turns': '{n} \u8f6e\u5bf9\u8bdd',
      'menu.pin': '\u7f6e\u9876',
      'menu.unpin': '\u53d6\u6d88\u7f6e\u9876',
      'menu.rename': '\u91cd\u547d\u540d',
      'menu.fork': '\u5206\u53c9\u4f1a\u8bdd',
      'menu.forkClean': '\u4f7f\u7528\u76f8\u540c\u914d\u7f6e\u65b0\u5efa\u4f1a\u8bdd',
      'menu.hide': '\u9690\u85cf',
      'menu.unhide': '\u53d6\u6d88\u9690\u85cf',
      'menu.archive': '\u5f52\u6863\uff08\u6c38\u4e45\uff09',
      'confirm.archive': '\u5f52\u6863\u662f\u6c38\u4e45\u6027\u7684\uff0c\u65e0\u6cd5\u6062\u590d\u3002\u662f\u5426\u7ee7\u7eed\uff1f',
      'empty.noWorkspaces': '\u6682\u65e0\u5de5\u4f5c\u533a\u3002\u6dfb\u52a0\u5de5\u4f5c\u533a\u4ee5\u5f00\u59cb\u4f1a\u8bdd\u3002',
      'empty.workspace': '\u6b64\u5de5\u4f5c\u533a\u6682\u65e0\u4f1a\u8bdd\u3002',
      'empty.search': '\u672a\u627e\u5230\u76f8\u5173\u5185\u5bb9\u3002',
      'error.search': '\u641c\u7d22\u5931\u8d25: {message}',
      'error.settings': '\u8bbe\u7f6e\u670d\u52a1\u4e0d\u53ef\u7528\uff0c\u7f6e\u9876\u548c\u9690\u85cf\u5df2\u5173\u95ed\u3002',
      'error.save': '\u4fdd\u5b58\u5931\u8d25: {message}',
      'error.rename': '\u91cd\u547d\u540d\u5931\u8d25: {message}',
      'error.archive': '\u5f52\u6863\u5931\u8d25: {message}',
      'error.addWorkspace': '\u6dfb\u52a0\u5de5\u4f5c\u533a\u5931\u8d25: {message}',
      'age.now': '\u521a\u521a',
      'age.min': '{n} \u5206\u949f',
      'age.hour': '{n} \u5c0f\u65f6',
      'age.day': '{n} \u5929',
      'viewer.readonly': '\u53ea\u8bfb',
      'viewer.close': '\u5173\u95ed',
      'viewer.you': '\u7528\u6237',
      'viewer.agent': '\u667a\u80fd\u4f53',
      'viewer.tool': '\u5de5\u5177: {name}',
      'viewer.loading': '\u6b63\u5728\u52a0\u8f7d\u8bb0\u5f55\u2026',
      'viewer.empty': '\u6b64\u4f1a\u8bdd\u65e0\u6d88\u606f\u3002',
      'viewer.unreadable': '\u65e7\u7248\u65e5\u5fd7\u683c\u5f0f\u65e0\u6cd5\u8bfb\u53d6\u3002',
      'viewer.truncated': '\u663e\u793a\u6700\u540e {shown} / {total} \u6761\u6d88\u606f\u3002',
      'viewer.failed': '\u8bfb\u53d6\u4f1a\u8bdd\u5931\u8d25: {message}',
      'viewer.copy': '\u590d\u5236\u4e3a Markdown',
      'viewer.save': '\u4fdd\u5b58 .md',
      'viewer.copied': '\u5df2\u590d\u5236\u5230\u526a\u8d34\u677f\u3002',
      'viewer.noClipboard': '\u526a\u8d34\u677f\u4e0d\u53ef\u7528',
      'viewer.exportFailed': '\u5bfc\u51fa\u5931\u8d25: {message}',
      'card.title': '\u4f1a\u8bdd\u63a7\u5236',
      'card.subtitle': '\u4fa7\u8fb9\u680f\u4e2d\u7684\u7f6e\u9876\u3001\u6807\u7b7e\u4e0e\u9690\u85cf\u4f1a\u8bdd\u3002',
      'card.loading': '\u52a0\u8f7d\u4e2d\u2026',
      'card.pinnedCount': '\u7f6e\u9876: {n}',
      'card.hiddenCount': '\u9690\u85cf: {n}',
      'card.labelsCount': '\u6807\u7b7e: {n}',
      'card.hideBlank': '\u9690\u85cf\u65e0\u6d88\u606f\u7684\u4f1a\u8bdd',
      'card.unhideAll': '\u5168\u90e8\u53d6\u6d88\u9690\u85cf',
      'size.warn': '\u4f1a\u8bdd\u8f83\u5927\uff1a{n} \u4e2a\u4e8b\u4ef6',
      'size.danger': '\u4f1a\u8bdd\u8fc7\u5927\uff0c\u754c\u9762\u53ef\u80fd\u5361\u987f\uff1a{n} \u4e2a\u4e8b\u4ef6',
      'size.tooltip': '{n} \u4e2a\u4e8b\u4ef6\uff0c{size}\u3002\u5728\u65b0\u4f1a\u8bdd\u4e2d\u7ee7\u7eed\u53ef\u4fdd\u6301\u754c\u9762\u6d41\u7545\u3002',
      'menu.handoff': '\u5728\u65b0\u4f1a\u8bdd\u4e2d\u7ee7\u7eed',
      'menu.handoffModel': '\u7528\u6a21\u578b\u603b\u7ed3\u540e\u5728\u65b0\u4f1a\u8bdd\u4e2d\u7ee7\u7eed',
      'menu.handoffModelOff': '\u7528\u6a21\u578b\u603b\u7ed3\u540e\u5728\u65b0\u4f1a\u8bdd\u4e2d\u7ee7\u7eed\uff08\u8bf7\u5148\u5728\u8bbe\u7f6e\u4e2d\u9009\u62e9\u6a21\u578b\uff09',
      'handoff.busy': '\u6b63\u5728\u51c6\u5907\u65b0\u4f1a\u8bdd\u2026',
      'error.handoff': '\u65e0\u6cd5\u5728\u65b0\u4f1a\u8bdd\u4e2d\u7ee7\u7eed\uff1a{message}',
      'error.handoffNoWorkspace': '\u8be5\u4f1a\u8bdd\u6ca1\u6709\u53ef\u7ee7\u7eed\u4f7f\u7528\u7684\u5de5\u4f5c\u533a',
      'card.sizeTitle': '\u4f1a\u8bdd\u5927\u5c0f',
      'card.sizeHint': '\u8fc7\u5927\u7684\u4f1a\u8bdd\u5728\u957f\u65f6\u95f4\u8fd0\u884c\u65f6\u53ef\u80fd\u5bfc\u81f4\u6d4f\u89c8\u5668\u6807\u7b7e\u9875\u5361\u6b7b\u3002\u5217\u8868\u4e2d\u5148\u663e\u793a\u9ec4\u8272\u6807\u8bb0\uff0c\u518d\u663e\u793a\u7ea2\u8272\u6807\u8bb0\u3002',
      'card.sizeWarn': '\u9ec4\u8272\u6807\u8bb0\u8d77\u70b9\uff08\u4e8b\u4ef6\u6570\uff09',
      'card.sizeDanger': '\u7ea2\u8272\u6807\u8bb0\u8d77\u70b9\uff08\u4e8b\u4ef6\u6570\uff09',
      'card.handoffTitle': '\u201c\u5728\u65b0\u4f1a\u8bdd\u4e2d\u7ee7\u7eed\u201d\u7684\u6a21\u578b\u603b\u7ed3',
      'card.handoffHint': '\u63d0\u4f9b\u5546\u6216\u6a21\u578b\u7559\u7a7a\u65f6\uff0c\u4ec5\u4f7f\u7528\u65e0\u9700\u6a21\u578b\u7684\u5373\u65f6\u6458\u5f55\u3002',
      'card.handoffProvider': '\u63d0\u4f9b\u5546 ID',
      'card.handoffModel': '\u6a21\u578b ID',
      'card.handoffMaxInput': '\u5bf9\u8bdd\u8bb0\u5f55\u9884\u7b97\uff08\u5b57\u7b26\uff09',
      'card.handoffTimeout': '\u8d85\u65f6\uff08\u79d2\uff09',
      'card.invalidNumber': '\u8bf7\u8f93\u5165\u5927\u4e8e\u96f6\u7684\u6574\u6570\u3002',
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
              () => uictx.locale.register(NS, { en, zh }),
              'dsh-session-control: en/zh locales',
            )
          } catch (taken) {
            console.warn('[dsh-session-control] locale already registered:',
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
            // #40: create a session in a workspace and resolve its id, without opening it yet.
            createSession: (workspaceId) => sessions.create({ workspaceId }),
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
                .catch(() => { /* branch failure preserves current selection */ })
            },
            forkCleanSession: (sessionId) => {
              const wsSnap = workspaces.list.getSnapshot()
              const targetWs = (wsSnap.items || []).find((item) => item.sessionIds && item.sessionIds.includes(sessionId))
              const wsId = targetWs ? targetWs.workspaceId : undefined
              uictx.get('uiWorkspace').startSession(wsId)
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

          // #40: invisible composer dock entry that places a parked handoff draft.
          uictx.slots.inject('conversation.input.dock', () => uictx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'dsh-session-control-handoff',
              order: 1000,
              locale: NS,
            },
            HandoffDock,
          ))
        } catch (uiFailed) {
          // Слот останется пустым, приложение — живым. Молчать нельзя:
          // именно молчаливый catch уже дал нам два невидимых дефекта.
          console.error('[dsh-session-control] UI failed to initialize:', uiFailed)
        }
      })
    }

    return module.exports
  },
})
