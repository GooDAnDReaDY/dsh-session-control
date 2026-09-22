/**
 * Browser half of @goodandready/dsh-session-control.
 *
 * Plugin consists of two independent halves.
 *
 * The "SERVICE" half provides `uiWorkspace` in place of the disabled kernel
 * ui-workspace row. This service is a REQUIRED injection target for
 * dsh-client-ui-sidebar and dsh-client-ui-conversation, so without it neither
 * the sidebar nor the conversation UI will mount (leaving a blank screen).
 * Its single duty is never to fail: no React, no plugin business logic, no settings.
 *
 * The "UI" half provides our session list in the sidebar.workspaces slot,
 * folder picker in conversation.hero.workspace, and settings card. It boots in
 * a separate child context and is entirely wrapped in try/catch: failure leaves
 * slots empty while keeping the host application alive.
 */
window.__ModuleLoader__.load({
  id: '@goodandready/dsh-session-control',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const cordis = require('@deepseek-ai/cordis')

    /**
     * Most recently active workspace directory.
     *
     * Folder freshness is the maximum `updatedAt` among its sessions; for empty
     * folders without sessions, folder creation time is used so newly created
     * folders can take precedence. Traversal order is deterministic.
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

    /** Directory selection failure preserved for caller without dropping error codes. */
    class DirectoryBrowseError extends Error {
      constructor(rpcError) {
        super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
        this.rpcError = rpcError
      }
    }

    let _deepseek_ai_dsh_client_store = null
    try {
      _deepseek_ai_dsh_client_store = require('@deepseek-ai/dsh-client-store')
    } catch (noStoreModule) {
      _deepseek_ai_dsh_client_store = null
    }

    function createFallbackSnapshotStore(initial = {}, options = {}) {
      let state = Object.assign({}, initial)
      const persistName = options && options.persist && options.persist.name
      if (typeof localStorage !== 'undefined' && persistName) {
        try {
          const raw = localStorage.getItem(persistName)
          if (raw) state = Object.assign({}, state, JSON.parse(raw))
        } catch (noStorage) {
          // localStorage access failed or JSON corrupted
        }
      }
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        set: (next) => {
          state = typeof next === 'function' ? next(state) : Object.assign({}, next)
          if (typeof localStorage !== 'undefined' && persistName) {
            try {
              localStorage.setItem(persistName, JSON.stringify(state))
            } catch (noStorage) {
              // localStorage write failed
            }
          }
          for (const l of listeners) {
            try {
              l(state)
            } catch (listenerFailed) {
              console.warn('[dsh-session-control] store listener failed:', listenerFailed)
            }
          }
        },
        subscribe: (l) => {
          listeners.add(l)
          return () => { listeners.delete(l) }
        },
      }
    }

    const createStore =
      _deepseek_ai_dsh_client_store && typeof _deepseek_ai_dsh_client_store.createSnapshotStore === 'function'
        ? _deepseek_ai_dsh_client_store.createSnapshotStore
        : createFallbackSnapshotStore

    /**
     * Folder and workspace operations expected by kernel modules.
     *
     * Matches kernel service surface verbatim: any discrepancy here manifests
     * not as a clean error but as a broken button in dependent modules.
     */
    class UiWorkspaceService extends cordis.Service {
      constructor(ctx, directoryPicker, workspaces, sessions) {
        super(ctx, 'uiWorkspace')
        this.directoryPicker = directoryPicker
        this.workspaces = workspaces
        this.sessions = sessions
        /** Pending directory attachments: prevents duplicate workspace creation. */
        this.connecting = new Map()
        this.lifetime = new AbortController()
        this.selection = createStore({}, { persist: { name: 'dsh.sessions.current' } })
        this.mainReference = undefined

        ctx.effect(() => {
          const stop = this.watchNavigation()
          return () => {
            stop()
            this.lifetime.abort()
            const reference = this.mainReference
            this.mainReference = undefined
            if (reference && typeof reference.release === 'function') {
              reference.release()
            }
          }
        }, 'dsh-session-control: folder navigation policy')
      }

      /**
       * Return the session to focus when navigating to a workspace folder.
       *
       * Reuses an empty session instead of spawning a new one: prevents each
       * folder click from accumulating empty "New session" rows.
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

      openSession(target) {
        this.replaceMain(target, this.lifetime.signal)
      }

      async openWorkspace(workspaceId, beforeOpen) {
        const layoutSignal = this.ctx.layout && typeof this.ctx.layout.beginNavigation === 'function'
          ? this.ctx.layout.beginNavigation()
          : undefined
        const signals = [this.lifetime.signal]
        if (layoutSignal) signals.unshift(layoutSignal)
        const navigation = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : this.lifetime.signal
        const sessionId = await this.connectWorkspace(workspaceId)
        if (navigation.aborted) return
        this.replaceMain(sessionId, navigation, beforeOpen)
      }

      async forkSession(sessionId) {
        const layoutSignal = this.ctx.layout && typeof this.ctx.layout.beginNavigation === 'function'
          ? this.ctx.layout.beginNavigation()
          : undefined
        const signals = [this.lifetime.signal]
        if (layoutSignal) signals.unshift(layoutSignal)
        const navigation = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : this.lifetime.signal
        const childId = await this.sessions.fork({
          sessionId,
          increaseTitle: true,
        })
        if (!navigation.aborted) this.replaceMain(childId, navigation)
      }

      startSession(workspaceId) {
        const workspace = this.workspaces.list.getSnapshot()
        const sessions = this.sessions.list.getSnapshot()
        const current = this.mainReference?.sessionId ?? sessions.current
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
          this.clearMain()
          return
        }

        this.openWorkspace(target).catch((reason) => {
          console.warn('[dsh-session-control] failed to start session:', reason)
        })
      }

      async archiveSession(sessionId) {
        await this.workspaces.archiveSession(sessionId)
        if (this.mainReference?.sessionId === sessionId || this.sessions.list.getSnapshot()?.current === sessionId) {
          this.clearMain()
        }
      }

      async unarchiveSession(sessionId) {
        await this.workspaces.unarchiveSession(sessionId)
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

      watchNavigation() {
        let initial = 'waiting'
        const reconcile = () => {
          if (this.lifetime.signal.aborted) return
          if (this.clearArchivedCurrent()) return
          if (initial !== 'waiting') return

          const workspace = this.workspaces.list.getSnapshot()
          const sessions = this.sessions.list.getSnapshot()
          if (workspace.phase !== 'ready' || sessions.phase !== 'ready') return
          if (this.mainReference !== undefined) {
            initial = 'done'
            return
          }

          const saved = this.selection.getSnapshot()
          const savedTarget =
            saved.subagentAddress ??
            (saved.sessionId !== undefined && sessions.byId && sessions.byId[saved.sessionId] !== undefined
              ? saved.sessionId
              : undefined)
          if (savedTarget !== undefined) {
            initial = 'connecting'
            try {
              if (saved.subagentAddress !== undefined && typeof this.sessions.refreshSubagents === 'function') {
                this.sessions.refreshSubagents(saved.subagentAddress.parentSessionId)
              }
              this.openSession(savedTarget)
              initial = 'done'
            } catch (reason) {
              initial = 'waiting'
              console.warn('[dsh-session-control] initial session restoration failed:', reason)
            }
            return
          }

          const target = recentWorkspace(workspace.items, sessions.byId)
          if (target === undefined) {
            initial = 'done'
            return
          }

          initial = 'connecting'
          this.connectWorkspace(target).then((sessionId) => {
            if (this.mainReference === undefined) this.openSession(sessionId)
          }).then(() => {
            initial = 'done'
          }, (reason) => {
            if (this.lifetime.signal.aborted) return
            initial = 'waiting'
            console.warn('[dsh-session-control] initial workspace selection failed:', reason)
          })
        }

        const disposeWorkspaces = this.workspaces.list.subscribe(reconcile)
        const disposeSessions = this.sessions.list.subscribe(reconcile)
        reconcile()

        return () => {
          this.lifetime.abort()
          disposeSessions()
          disposeWorkspaces()
        }
      }

      clearArchivedCurrent() {
        const current = this.mainReference?.sessionId ?? this.sessions.list.getSnapshot()?.current
        if (
          current === undefined ||
          !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)
        ) {
          return false
        }
        this.clearMain()
        return true
      }

      clearMain() {
        const previous = this.mainReference
        this.mainReference = undefined
        this.selection.set({})
        if (previous && typeof previous.release === 'function') {
          previous.release()
        }

        if (this.ctx.layout && typeof this.ctx.layout.selectPanel === 'function') {
          this.ctx.layout.selectPanel(null)
        }
      }

      replaceMain(target, signal, beforeOpen) {
        if (signal && typeof signal.throwIfAborted === 'function') {
          signal.throwIfAborted()
        }
        const reference = this.sessions.retain(target, { source: 'mainView' })
        try {
          if (signal && typeof signal.throwIfAborted === 'function') {
            signal.throwIfAborted()
          }
          beforeOpen?.(reference.sessionId)
          if (signal && signal.aborted) {
            reference.release()
            return
          }
          const subagentAddress = typeof target === 'string'
            ? (typeof this.sessions.subagentAddress === 'function' ? this.sessions.subagentAddress(reference.sessionId) : undefined)
            : target
          this.selection.set({
            sessionId: reference.sessionId,
            ...(subagentAddress === undefined ? {} : { subagentAddress }),
          })
        } catch (error) {
          reference.release()
          throw error
        }
        const previous = this.mainReference
        this.mainReference = reference
        if (previous && typeof previous.release === 'function') {
          previous.release()
        }
        if (typeof this.sessions.refreshSubagents === 'function') {
          this.sessions.refreshSubagents(reference.sessionId)
        }
        if (this.ctx.layout && typeof this.ctx.layout.selectPanel === 'function') {
          this.ctx.layout.selectPanel(null)
        }
      }
    }

    // ================================================================
    // UI Half
    //
    // Everything below is optional for host survival: if anything fails here,
    // the sidebar.workspaces slot stays empty, but sidebar, settings, and
    // conversation keep functioning via the service half. Registration runs in
    // a child context enclosed in try/catch.
    // ================================================================

    const React = require('react')
    const h = React.createElement

    /** Reuses kernel chevron icon component for visual consistency. */
    let ChevronIcon = null
    let SearchIcon = null
    let AddIcon = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      ChevronIcon = primitives && primitives.IconChevronDownOutline14
      SearchIcon = primitives && primitives.IconSearchOutline16
      AddIcon = primitives && primitives.IconProjectAddOutline16
    } catch (noPrimitives) {
      // In minimal builds the icon set may not exist: guarded require prevents
      // failing the entire UI half.
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
     * Injects styles once per document.
     *
     * Horizontal padding uses kernel sidebar CSS variables so session items
     * align vertically with the "New session" header button. Avoids hardcoded
     * values that break on core layout updates.
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
  align-items:flex-start; padding-top:12vh; background:var(--dsw-alias-mask, color-mix(in srgb, black 45%, transparent)) }
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
  background:var(--dsw-alias-bg-layer-3); box-shadow:0 8px 24px color-mix(in srgb, black 28%, transparent) }
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
  justify-content:center; background:var(--dsw-alias-mask, color-mix(in srgb, black 45%, transparent)) }
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
.dsc-update-bar { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-2) }
.dsc-update-info { display:flex; align-items:center; gap:8px; font-size:13px }
.dsc-update-ver { font-weight:500; color:var(--dsw-alias-label-secondary) }
.dsc-update-status { font-size:12px; color:var(--dsw-alias-label-tertiary) }
.dsc-badge { font-size:11px; padding:2px 8px; border-radius:10px; font-weight:500 }
.dsc-badge-ok { color:var(--dsw-alias-state-success-primary); background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent) }
.dsc-badge-warn { color:var(--dsw-alias-state-warn-primary); background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent) }
.dsc-update-notice { font-size:12px; color:var(--dsw-alias-state-success-primary); padding:4px 6px }
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

    /** Relative age bucket matching kernel sidebar tiers. */
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
     * Time bucket key for session timestamp.
     *
     * Uses calendar-based day boundaries ("today", "yesterday", "this week")
     * rather than rolling 24-hour offsets.
     *
     * @param updatedAt - Session last updated timestamp.
     * @param now - Reference timestamp.
     * @returns Period bucket key.
     */
    function periodOf(updatedAt, now) {
      const day = new Date(now); day.setHours(0, 0, 0, 0)
      const startOfToday = day.getTime()
      if (updatedAt >= startOfToday) return 'today'
      if (updatedAt >= startOfToday - 6 * 86400000) return 'week'
      if (updatedAt >= startOfToday - 29 * 86400000) return 'month'
      return 'older'
    }

    /** Periods ordered chronologically. */
    const PERIODS = ['today', 'week', 'month', 'older']

    /** Subscription to settings namespace; tracks status and values. */
    function useSettings(scope) {
      const snapshot = React.useSyncExternalStore(
        React.useMemo(() => (cb) => (scope && typeof scope.subscribe === 'function' ? scope.subscribe(cb) : () => {}), [scope]),
        React.useCallback(() => {
          if (!scope || typeof scope.getSnapshot !== 'function') {
            return { status: 'unavailable', value: {} }
          }
          return scope.getSnapshot() || { status: 'unavailable', value: {} }
        }, [scope]),
        React.useCallback(() => ({ status: 'loading', value: {} }), []),
      )
      const status = (snapshot && snapshot.status) || (scope ? 'loading' : 'unavailable')
      const value = (snapshot && snapshot.value) || {}
      return {
        status,
        pinned: Array.isArray(value.pinned) ? value.pinned : [],
        hidden: Array.isArray(value.hidden) ? value.hidden : [],
        // Hide empty sessions until settings arrive to avoid visual layout jumps.
        hideBlank: value.hideBlank !== false,
        // Labels provide workspace-independent tagging. Kernel does not track labels.
        labels: (value.labels && typeof value.labels === 'object') ? value.labels : {},
        // #39: size badge thresholds; the server normalizes them, so any number is safe here.
        sizeWarnEvents: typeof value.sizeWarnEvents === 'number' ? value.sizeWarnEvents : 1500,
        sizeDangerEvents: typeof value.sizeDangerEvents === 'number' ? value.sizeDangerEvents : 3000,
        // #41: model summary route; empty provider or model disables it.
        handoffProvider: typeof value.handoffProvider === 'string' ? value.handoffProvider : '',
        handoffModel: typeof value.handoffModel === 'string' ? value.handoffModel : '',
        handoffMaxInputChars: typeof value.handoffMaxInputChars === 'number' ? value.handoffMaxInputChars : 60000,
        handoffTimeoutSeconds: typeof value.handoffTimeoutSeconds === 'number' ? value.handoffTimeoutSeconds : 90,
        writable: status === 'ready' && snapshot.writable !== false,
      }
    }

    /**
     * Section collapsed state is local UI view state, stored in localStorage
     * rather than synced over host settings.
     */
    function useCollapsed() {
      const [state, setState] = React.useState(() => {
        try {
          return JSON.parse(window.localStorage.getItem('dsc.collapsed') || '{}') || {}
        } catch (noStorage) {
          return {}
        }
      })
      // Sections have different defaults: folders expanded, hidden/archive
      // collapsed. Toggle logic accounts for section defaults.
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

    /** Context menu for session item. Closes on Escape or outside click. */
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

    /** Single session item component. */
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
              // Clicking selection checkbox does not open session; selection
              // and navigation are distinct actions.
              onClick: (e) => { e.stopPropagation(); onSelect(node.id, e.shiftKey) },
              onChange: () => {},
            })
          : null,
        pinned ? h('span', { className: 'dsc-pin', title: t('menu.unpin'), 'aria-hidden': 'true' }, '•') : null,
        h('span', { className: 'dsc-row-lines' },
          h('span', { className: 'dsc-row-title' }, title),
          // Snippet displays only during active search to show matching context.
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

    /** Collapsible section component with header toggle. */
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
     * Read-only modal viewer for archived session transcripts.
     *
     * Fetches transcript via plugin HTTP endpoint instead of client session manager.
     * Client history only mounts for active sessions, but archived sessions
     * cannot be active. Plugin backend reads raw logs without booting live sessions.
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

      // Markdown generation runs on backend; browser downloads completed artifact.
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
          // Clipboard API requires secure context (HTTPS/localhost); falls back
          // to file download when unavailable.
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
     * Keyboard quick switcher modal.
     *
     * Matches sidebar search logic: instant title match, debounced server content match.
     * Navigation only; modal overlay avoids destructive state changes.
     */
    function QuickJump({ t, sessions, searchSessions, onPick, onClose }) {
      const [query, setQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      const [remote, setRemote] = React.useState(null)
      const [cursor, setCursor] = React.useState(0)
      const [failed, setFailed] = React.useState('')
      const searchRef = React.useRef(searchSessions)
      searchRef.current = searchSessions

      // Restores focus to previous active element on modal dismissal.
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

    /** Session list component: sidebar body. */
    function SessionListPanel(props) {
      const t = props.t
      const scope = props.configForms || props.scope
      const settings = useSettings(scope)
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
      // Inferred titles: sessionId -> beginning of first user prompt.
      const [derived, setDerived] = React.useState({})
      // #39: sizes of rows on screen, asked once per row like derived titles.
      const [sizes, setSizes] = React.useState({})
      const sizeAskedRef = React.useRef(new Set())
      // #40/#41: session id currently being handed off, or null.
      const [handoffBusy, setHandoffBusy] = React.useState(null)
      // Requested title cache: fetched once per page lifecycle since first prompt never changes.
      const askedRef = React.useRef(new Set())
      // Visible row IDs: collapsed sections are omitted so titles are only fetched for visible items.
      const renderedRef = React.useRef([])
      const selectedSet = React.useMemo(() => new Set(selected), [selected])
      // Display order for shift-selection: reflects current visible list order.
      const orderRef = React.useRef([])

      React.useEffect(() => { ensureStyles() }, [])

      const workspaces = props.useWorkspaces((s) => s.items)
      const workspacePhase = props.useWorkspaces((s) => s.phase)
      const archivedIds = props.useWorkspaces((s) => s.archivedSessionIds)
      const sessionsById = props.useSessions((s) => s.byId)
      const sessionPhase = props.useSessions((s) => s.phase)
      const currentId = props.useSessions((s) => {
        if (s && s.current !== undefined) return s.current
        const byId = s && s.byId
        if (!byId) return undefined
        for (const id of Object.keys(byId)) {
          const item = byId[id]
          if (item && item.retainedBy && (item.retainedBy.mainView ?? 0) > 0) {
            return item.id || id
          }
        }
        return undefined
      })
      const flowAvailable = props.useDirectoryFlow((occupied) => occupied)

      // Search instance stored in ref; effect depends strictly on query string.
      //
      // Prevents re-running search on unrelated store updates, which would
      // cancel active requests mid-flight and cause intermittent search drops.
      const searchRef = React.useRef(props.searchSessions)
      searchRef.current = props.searchSessions

      // Debounces content search to host to avoid querying on every keystroke.
      React.useEffect(() => {
        const text = query.trim()
        if (text === '') { setFound(null); setSearchFailed(''); return undefined }
        let cancelled = false
        const controller = new AbortController()
        const timer = setTimeout(() => {
          searchRef.current(text, controller.signal).then(
            (res) => {
              if (cancelled) return
              // Retain matching snippet precomputed by host.
              const byId = {}
              for (const item of res.items) byId[item.sessionId] = item.snippet || ''
              setFound(byId)
              setSearchFailed('')
            },
            (e) => {
              // Abort errors are suppressed; surface real errors to distinguish from empty results.
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
          // User-set session title always takes precedence over inferred title.
          named: typeof s.title === 'string' && s.title !== '',
          blank: s.blank === true,
          running: s.running === true,
          updatedAt: s.updatedAt || 0,
          turnsCount,
        }
      }, [sessionsById])

      // Empty sessions (e.g. from cron/webhook bots) are filtered unless active.
      const visible = React.useCallback(
        (node) => !(settings.hideBlank && node.blank && node.id !== currentId),
        [settings.hideBlank, currentId],
      )

      const pinnedSet = React.useMemo(() => new Set(settings.pinned), [settings.pinned])
      const hiddenSet = React.useMemo(() => new Set(settings.hidden), [settings.hidden])
      const archivedSet = React.useMemo(() => new Set(archivedIds || []), [archivedIds])

      const labels = settings.labels
      const labelNames = React.useMemo(() => Object.keys(labels).sort(), [labels])

      // When a filtered label no longer has sessions, reset filter to avoid empty view.
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

      // Flattened list of visible rows for Shift-range selection calculation.
      orderRef.current = []
        .concat(pinnedRows.map((r) => r.id))
        .concat(...groups.map((g) => g.rows.map((r) => r.id)))
        .concat(hiddenRows.map((r) => r.id))
        .concat(...PERIODS.map((p) => archiveByPeriod[p].map((r) => r.id)))

      // Clears selection on search query change to avoid actions on hidden rows.
      React.useEffect(() => { setSelected([]); lastPicked.current = null }, [query, labelFilter])

      const writeList = async (key, next) => {
        setError('')
        try {
          if (!scope || typeof scope.set !== 'function') {
            throw new Error('Settings scope unavailable')
          }
          await scope.set(key, next)
        } catch (e) {
          setError(t('error.save', { message: (e && e.message) || String(e) }))
        }
      }

      /**
       * Toggle label assignment on a batch of sessions.
       *
       * Unused labels are automatically pruned from settings to keep filters clean.
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

      // Moving between workspace folders is unsupported: session membership
      // derives strictly from workspace cwd, enforced in attachSession.
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
        // Separator isolates label management from hide/archive actions.
        if (labelNames.length > 0) items.push({ separator: true })
        for (const name of labelNames) {
          const on = Array.isArray(labels[name]) && labels[name].includes(node.id)
          items.push({
            key: 'label:' + name,
            // Verb action label distinguishes add vs remove operations clearly.
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
            // Requires confirmation because core session archive is irreversible in UI.
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

      // Archived sessions open in transcript viewer; cannot be selected as active session.
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
        // Title resolution order: custom title -> inferred title -> directory/id fallback.
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
       * Fetch inferred titles for currently visible rows.
       *
       * Intentional effect without deps: tracks rendered rows after sections expand,
       * searches, or filters. Deduplication avoids repeating requested IDs.
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

      // Complete session list for quick switcher, including archived sessions.
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
       * Keyboard shortcut toggles quick switcher.
       *
       * Uses Alt instead of Ctrl: browsers capture Ctrl+K for address bar / search.
       * Alt+K does not conflict with core or adjacent plugin shortcuts.
       *
       * Also checks corresponding Cyrillic key (\u043b) for Alt+K shortcut reliability.
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

      // Compact sidebar mode: matches width allocated to standard sidebar block.
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

      // Row items reassembled per render to reflect current visibility and ordering.
      renderedRef.current = []

      const loading = workspacePhase !== 'ready' || sessionPhase !== 'ready'
      // Auto-expands sections during active search or label filter to show matches.
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
                // Collapsed period sections skip rendering child rows for DOM efficiency.
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
              // Batch label untagging is scoped to active label filter.
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
        // Folder selection flow: plugin controls button and path assignment.
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
     * Workspace folder picker for empty conversation screen.
     *
     * Replaces core slot so empty conversation view still provides folder selection.
     */
    function HeroWorkspacePicker(props) {
      const t = props.t
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const available = props.useDirectoryFlow((occupied) => occupied)

      React.useEffect(() => { ensureStyles() }, [])

      // Child slot renders unconditionally to avoid mounting/unmounting subtrees.
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

    /** Settings card rendered under Settings -> Plugins -> Plugin Settings. */
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
      const scope = React.useMemo(() => {
        try {
          if (ctx && ctx.configForms && typeof ctx.configForms.get === 'function') {
            return ctx.configForms.get(NS)
          }
        } catch (_) {}
        return undefined
      }, [ctx])
      const settings = useSettings(scope)
      React.useEffect(() => { ensureStyles() }, [])

      const [updateState, setUpdateState] = React.useState({
        checking: false,
        updating: false,
        currentVersion: '0.2.3',
        latestVersion: '',
        updateAvailable: false,
        canAutoUpdate: true,
        error: '',
        notice: '',
      })

      const checkUpdate = React.useCallback(async () => {
        setUpdateState((s) => ({ ...s, checking: true, error: '' }))
        try {
          const res = await fetch('/api/dsh-session-control/update')
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const data = await res.json().catch(() => ({}))
          setUpdateState((s) => ({
            ...s,
            checking: false,
            currentVersion: data.currentVersion || s.currentVersion,
            latestVersion: data.latestVersion || '',
            updateAvailable: Boolean(data.updateAvailable),
            canAutoUpdate: data.canAutoUpdate !== false,
          }))
        } catch (e) {
          setUpdateState((s) => ({ ...s, checking: false }))
        }
      }, [])

      React.useEffect(() => {
        if (open) checkUpdate()
      }, [open, checkUpdate])

      async function handleTriggerUpdate() {
        if (updateState.updating) return
        setUpdateState((s) => ({ ...s, updating: true, error: '', notice: '' }))
        try {
          const res = await fetch('/api/dsh-session-control/update', {
            method: 'POST',
            headers: { 'x-dsh-plugin-update': '1' },
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.ok === false || data.error) {
            throw new Error(data.error || ('HTTP ' + res.status))
          }
          const newVer = data.updatedVersion || updateState.latestVersion || updateState.currentVersion
          setUpdateState((s) => ({
            ...s,
            updating: false,
            updateAvailable: false,
            currentVersion: newVer,
            notice: t('update.done', { version: newVer }),
          }))
          setTimeout(() => checkUpdate(), 2000)
        } catch (err) {
          setUpdateState((s) => ({
            ...s,
            updating: false,
            error: t('update.failed', { error: String(err.message || err) }),
          }))
        }
      }

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
                })),
              h('div', { className: 'dsc-card-group' },
                h('span', { className: 'dsc-card-group-title' }, t('card.updaterTitle')),
                h('div', { className: 'dsc-update-bar' },
                  h('div', { className: 'dsc-update-info' },
                    h('span', { className: 'dsc-update-ver' }, 'v' + updateState.currentVersion),
                    updateState.checking
                      ? h('span', { className: 'dsc-update-status' }, t('update.checking'))
                      : updateState.updateAvailable
                        ? h('span', { className: 'dsc-badge dsc-badge-warn' },
                            t('update.available', { latest: updateState.latestVersion, current: updateState.currentVersion }))
                        : h('span', { className: 'dsc-badge dsc-badge-ok' }, '✓ ' + t('update.upToDate'))
                  ),
                  updateState.updateAvailable
                    ? h('button', {
                        type: 'button',
                        className: 'dsc-card-action',
                        disabled: updateState.updating,
                        onClick: handleTriggerUpdate,
                      }, updateState.updating ? t('update.updating') : t('update.btn'))
                    : null
                ),
                updateState.notice ? h('div', { className: 'dsc-update-notice' }, '✓ ' + updateState.notice) : null,
                updateState.error ? h('div', { className: 'dsc-error' }, updateState.error) : null
              ))

      // Row seat (plugins.row.config): the host page draws title/icon/crumb and the
      // padding, so the summary is a one-liner and the page drops our card chrome.
      if (props && props.view === 'summary') {
        return h('span', { className: 'dsc-card-sub' }, t('card.subtitle'))
      }
      const page = !!(props && props.view === 'page')

      return h(
        page ? 'div' : 'li',
        { className: page ? 'dsc-page' : 'dsc-card' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsc-card-head',
            style: page ? { display: 'none' } : undefined,
            'aria-expanded': (page || open) ? 'true' : 'false',
            onClick: () => setOpen((v) => !v),
          },
          h('span', { className: 'dsc-card-text' },
            h('span', { className: 'dsc-card-title' }, t('card.title')),
            h('span', { className: 'dsc-card-sub' }, t('card.subtitle'))),
          h(Chevron, { className: 'dsc-card-chev' + (open ? ' dsc-card-chev-open' : '') }),
        ),
        (page || open) ? h('div', { className: 'dsc-card-body' }, body) : null,
      )
    }

    /** Settings namespace matching card key. */
    const NS = 'dsh-session-control'
    // Plugins page row seat (DSH 0.1.6-alpha.2): key = '<package name>#<row id>'.
    const PKG = '@goodandready/dsh-session-control'
    const ROW_ID = 'dsh-session-control'
    const ROW_CONFIG_KEY = PKG + '#' + ROW_ID

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
      'card.updaterTitle': 'Plugin update',
      'update.checking': 'Checking for updates…',
      'update.available': 'Update available: v{latest}',
      'update.upToDate': 'Up to date',
      'update.btn': 'Update now',
      'update.updating': 'Updating…',
      'update.done': 'Updated to v{version}. Please restart DSH to apply changes.',
      'update.failed': 'Update failed: {error}',
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
      'card.updaterTitle': '\u63d2\u4ef6\u66f4\u65b0',
      'update.checking': '\u6b63\u5728\u68c0\u67e5\u66f4\u65b0\u2026',
      'update.available': '\u53d1\u73b0\u65b0\u7248\u672c\uff1av{latest}',
      'update.upToDate': '\u5df2\u662f\u6700\u65b0\u7248\u672c',
      'update.btn': '\u7acb\u5373\u66f4\u65b0',
      'update.updating': '\u6b63\u5728\u66f4\u65b0\u2026',
      'update.done': '\u5df2\u66f4\u65b0\u81f3 v{version}\u3002\u8bf7\u91cd\u542f DSH \u4ee5\u5e94\u7528\u66f4\u65b0\u3002',
      'update.failed': '\u66f4\u65b0\u5931\u8d25\uff1a{error}',
    }


    // Service half minimizes dependencies to ensure app boot reliability.
    exports.inject = ['slots', 'sessions', 'workspaces', 'remote', 'remote.directoryPicker', 'layout']

    exports.apply = function apply(ctx) {
      const sessions = ctx.get('sessions')
      const workspaces = ctx.get('workspaces')

      // ---- SERVICE HALF ----
      new UiWorkspaceService(ctx, ctx.remote.directoryPicker, workspaces, sessions)
      ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })

      // ---- UI HALF ----
      // Child context: if UI services fail, core workspace service remains active.
      ctx.inject(['locale', 'configForms'], (uictx) => {
        try {
          // Register locales defensively so translation conflicts do not break UI.
          //
          // Client tree may apply multiple times during page reload.
          // Guard duplicate locale registration errors so UI registration
          // (list, folder picker, settings card) always succeeds.
          // Plugin ships English and Chinese built-in; Russian is supplied
          // externally by the localization plugin sharing the namespace.
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

          // Child slot occupancy source must remain stable for hook caching.
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
          const configScope = (uictx && uictx.configForms && typeof uictx.configForms.get === 'function')
            ? uictx.configForms.get(NS)
            : undefined

          const browserInjected = () => ({
            configForms: configScope,
            scope: configScope,
            startSession: (workspaceId) => {
              const uiWs = uictx.get('uiWorkspace')
              if (uiWs && typeof uiWs.startSession === 'function') {
                uiWs.startSession(workspaceId)
              }
            },
            open: (sessionId) => {
              const uiWs = uictx.get('uiWorkspace')
              if (uiWs && typeof uiWs.openSession === 'function') {
                uiWs.openSession(sessionId)
              }
            },
            selection: uictx.get('uiWorkspace')?.selection,
            // #40: create a session in a workspace and resolve its id, without opening it yet.
            createSession: (workspaceId) => sessions.create({ workspaceId }),
            searchSessions,
            searchResultLimit: sessions.searchResultLimit,
            renameSession: async (sessionId, title) => {
              if (typeof sessions.using === 'function') {
                const result = await sessions.using(
                  sessionId,
                  { source: 'workspaceOperation' },
                  (reference) => reference.binding.session.rename(title),
                )
                if (!result.ok) throw new Error(result.error.message)
                return
              }
              const session = sessions.binding(sessionId)?.session
              if (session === undefined) throw new Error(`unknown session "${sessionId}"`)
              const result = await session.rename(title)
              if (!result.ok) throw new Error(result.error.message)
            },
            forkSession: (sessionId) => {
              const uiWs = uictx.get('uiWorkspace')
              if (uiWs && typeof uiWs.forkSession === 'function') {
                uiWs.forkSession(sessionId).catch(() => {})
              } else {
                sessions.fork({ sessionId, increaseTitle: true })
                  .then((childId) => {
                    if (uiWs && typeof uiWs.openSession === 'function') {
                      uiWs.openSession(childId)
                    }
                  })
                  .catch(() => {})
              }
            },
            forkCleanSession: (sessionId) => {
              const wsSnap = workspaces.list.getSnapshot()
              const targetWs = (wsSnap.items || []).find((item) => item.sessionIds && item.sessionIds.includes(sessionId))
              const wsId = targetWs ? targetWs.workspaceId : undefined
              const uiWs = uictx.get('uiWorkspace')
              if (uiWs && typeof uiWs.startSession === 'function') {
                uiWs.startSession(wsId)
              }
            },
            archiveSession: async (sessionId) => {
              const uiWs = uictx.get('uiWorkspace')
              if (uiWs && typeof uiWs.archiveSession === 'function') {
                await uiWs.archiveSession(sessionId)
              } else {
                await workspaces.archiveSession(sessionId)
              }
            },
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

          // Plugin-list seat (plugins.item) first: the seat the current core
          // (0.1.6-alpha.2) renders as the plugin's own page with its configuration. The
          // label is a static string on purpose — it is resolved while the page renders,
          // and a locale lookup there would take the whole client batch down with it.
          uictx.slots.inject('plugins.item', () => uictx.slots.register(
            {
              name: 'plugins.item',
              id: ROW_ID,
              order: 60,
              label: () => 'Session Control',
              locale: NS,
              inject: () => ({ ctx: uictx }),
            },
            SettingsCard,
          ))

          // Row seat and the legacy seat stay as fallbacks.
          uictx.slots.inject('plugins.row.config', () => uictx.slots.register(
            {
              name: 'plugins.row.config',
              key: ROW_CONFIG_KEY,
              locale: NS,
              inject: () => ({ ctx: uictx }),
            },
            SettingsCard,
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
          // Slot remains empty while app stays alive; log error for diagnostics.
          console.error('[dsh-session-control] UI failed to initialize:', uiFailed)
        }
      })
    }

    return module.exports
  },
})
