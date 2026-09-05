/**
 * Браузерная половина dsh-session-control.
 *
 * Плагин состоит из двух независимых половин, и здесь пока только первая.
 *
 * Половина «СЕРВИС» отдаёт `uiWorkspace` вместо выключенного ядрового ряда
 * ui-workspace. Этот сервис стоит в ОБЯЗАТЕЛЬНОМ inject у
 * dsh-client-ui-sidebar и dsh-client-ui-conversation, поэтому без него не
 * поднимутся ни боковая панель, ни интерфейс беседы — экран будет пустой.
 * Её единственная задача — никогда не падать: ни React, ни нашей логики, ни
 * настроек здесь нет и быть не должно.
 *
 * Половина «ИНТЕРФЕЙС» — наш список сессий в слоте sidebar.workspaces и выбор
 * папки в conversation.hero.workspace. Она появится отдельно и будет целиком
 * обёрнута в try/catch: её отказ обязан оставлять слот пустым, но приложение
 * живым.
 *
 * Пока интерфейса нет, тело боковой панели пустое — это ожидаемое состояние
 * промежуточного шага, а не дефект.
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

    exports.inject = ['slots', 'sessions', 'workspaces', 'locale', 'remote', 'remote.directoryPicker']

    exports.apply = function apply(ctx) {
      const sessions = ctx.get('sessions')
      const workspaces = ctx.get('workspaces')

      // Половина «сервис». Всё, что ниже, обязано подниматься при любом
      // состоянии интерфейса: от него зависят чужие модули.
      new UiWorkspaceService(ctx, ctx.remote.directoryPicker, workspaces, sessions)

      // Корневой хук списка папок: его читают компоненты чужих слотов, а не
      // только наши. Уходит вместе с ядровым рядом, поэтому отдаём как было.
      ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })
    }

    return module.exports
  },
})
