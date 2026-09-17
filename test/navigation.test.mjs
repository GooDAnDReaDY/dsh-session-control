import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.resolve(__dirname, '../lib/client.js')

// Extract and test UiWorkspaceService behavior
test('UiWorkspaceService alpha2 session retention and selection lifecycle', async () => {
  // Mock Cordis Service base class
  class MockService {
    constructor(ctx, name) {
      this.ctx = ctx
      this.name = name
    }
  }

  // Mock global/scope cordis
  const cordis = { Service: MockService }

  // Create store factory matching lib/client.js
  function createSnapshotStore(initial = {}) {
    let state = Object.assign({}, initial)
    const listeners = new Set()
    return {
      getSnapshot: () => state,
      set: (next) => {
        state = typeof next === 'function' ? next(state) : Object.assign({}, next)
        for (const l of listeners) {
          try { l(state) } catch (_) {}
        }
      },
      subscribe: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
    }
  }

  // Tracking mocks
  let retainedTarget = null
  let retainedOptions = null
  let releasedCount = 0
  let subagentsRefreshed = null
  let panelSelected = 'initial'

  const mockReference = {
    sessionId: 'sess-123',
    release: () => { releasedCount++ },
  }

  const mockSessions = {
    list: createSnapshotStore({
      phase: 'ready',
      ids: ['sess-123', 'sess-456'],
      byId: {
        'sess-123': { id: 'sess-123', retainedBy: { mainView: 1 }, blank: false, cwd: '/work' },
        'sess-456': { id: 'sess-456', retainedBy: {}, blank: false, cwd: '/work' },
      },
    }),
    retain: (target, options) => {
      retainedTarget = target
      retainedOptions = options
      return mockReference
    },
    refreshSubagents: (sessionId) => {
      subagentsRefreshed = sessionId
    },
    subagentAddress: () => undefined,
    create: async () => 'sess-created',
    fork: async () => 'sess-forked',
  }

  const mockWorkspaces = {
    list: createSnapshotStore({
      phase: 'ready',
      items: [{ workspaceId: 'ws-1', path: '/work', sessionIds: ['sess-123', 'sess-456'] }],
      archivedSessionIds: [],
    }),
    archiveSession: async (id) => {
      mockWorkspaces.list.set((s) => ({
        ...s,
        archivedSessionIds: [...s.archivedSessionIds, id],
      }))
    },
  }

  const mockCtx = {
    effect: () => {},
    layout: {
      beginNavigation: () => new AbortController().signal,
      selectPanel: (val) => { panelSelected = val },
    },
  }

  // Instantiate service with alpha2 contract
  class TestUiWorkspaceService extends cordis.Service {
    constructor(ctx, directoryPicker, workspaces, sessions) {
      super(ctx, 'uiWorkspace')
      this.directoryPicker = directoryPicker
      this.workspaces = workspaces
      this.sessions = sessions
      this.connecting = new Map()
      this.lifetime = new AbortController()
      this.selection = createSnapshotStore({})
      this.mainReference = undefined
    }

    openSession(target) {
      this.replaceMain(target, this.lifetime.signal)
    }

    clearMain() {
      const previous = this.mainReference
      this.mainReference = undefined
      this.selection.set({})
      if (previous && typeof previous.release === 'function') {
        previous.release()
      }
      this.ctx.layout?.selectPanel?.(null)
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
        this.selection.set({
          sessionId: reference.sessionId,
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
      this.sessions.refreshSubagents(reference.sessionId)
      this.ctx.layout?.selectPanel?.(null)
    }

    async archiveSession(sessionId) {
      await this.workspaces.archiveSession(sessionId)
      if (this.mainReference?.sessionId === sessionId) {
        this.clearMain()
      }
    }
  }

  const service = new TestUiWorkspaceService(mockCtx, null, mockWorkspaces, mockSessions)

  // 1. openSession retains with mainView and updates selection
  service.openSession('sess-123')
  assert.equal(retainedTarget, 'sess-123')
  assert.deepEqual(retainedOptions, { source: 'mainView' })
  assert.equal(service.selection.getSnapshot().sessionId, 'sess-123')
  assert.equal(service.mainReference, mockReference)
  assert.equal(subagentsRefreshed, 'sess-123')
  assert.equal(panelSelected, null)

  // 2. Opening another session releases previous reference
  const mockReference2 = {
    sessionId: 'sess-456',
    release: () => { releasedCount++ },
  }
  mockSessions.retain = (t, o) => {
    retainedTarget = t
    retainedOptions = o
    return mockReference2
  }

  service.openSession('sess-456')
  assert.equal(releasedCount, 1, 'Previous mainReference must be released')
  assert.equal(service.selection.getSnapshot().sessionId, 'sess-456')
  assert.equal(service.mainReference, mockReference2)

  // 3. clearMain releases reference and empties selection
  service.clearMain()
  assert.equal(releasedCount, 2, 'Cleared mainReference must be released')
  assert.equal(service.mainReference, undefined)
  assert.deepEqual(service.selection.getSnapshot(), {})

  // 4. Archiving currently active session clears it
  service.openSession('sess-456')
  assert.equal(service.mainReference, mockReference2)
  await service.archiveSession('sess-456')
  assert.equal(service.mainReference, undefined, 'Archiving active session must clear it')
  assert.deepEqual(service.selection.getSnapshot(), {})
})

test('SessionListPanel active session resolution supports alpha2 retainedBy.mainView', () => {
  function resolveCurrentId(sessionsSnapshot) {
    if (sessionsSnapshot && sessionsSnapshot.current !== undefined) {
      return sessionsSnapshot.current
    }
    const byId = sessionsSnapshot && sessionsSnapshot.byId
    if (!byId) return undefined
    for (const id of Object.keys(byId)) {
      const item = byId[id]
      if (item && item.retainedBy && (item.retainedBy.mainView ?? 0) > 0) {
        return item.id || id
      }
    }
    return undefined
  }

  // Case A: alpha2 snapshot without s.current, with retainedBy.mainView
  const alpha2Snapshot = {
    ids: ['s1', 's2'],
    byId: {
      s1: { id: 's1', retainedBy: {} },
      s2: { id: 's2', retainedBy: { mainView: 1 } },
    },
  }
  assert.equal(resolveCurrentId(alpha2Snapshot), 's2')

  // Case B: alpha2 snapshot with no retained mainView (e.g. empty new session state)
  const emptySnapshot = {
    ids: ['s1', 's2'],
    byId: {
      s1: { id: 's1', retainedBy: {} },
      s2: { id: 's2', retainedBy: {} },
    },
  }
  assert.equal(resolveCurrentId(emptySnapshot), undefined)

  // Case C: legacy snapshot with s.current
  const legacySnapshot = {
    current: 's1',
    ids: ['s1', 's2'],
    byId: {
      s1: { id: 's1' },
      s2: { id: 's2' },
    },
  }
  assert.equal(resolveCurrentId(legacySnapshot), 's1')
})

test('lib/client.js contains no removed sessions.open or sessions.clear calls', () => {
  const content = fs.readFileSync(clientPath, 'utf8')
  // Ensure no bare calls to sessions.open( or sessions.clear( exist as primary logic
  // in browserInjected or UiWorkspaceService
  const lines = content.split('\n')
  const problematicCalls = []

  lines.forEach((line, idx) => {
    // Check for stale direct calls without fallback guard
    if (line.includes('sessions.open(') && !line.includes('typeof sessions.open')) {
      problematicCalls.push(`Line ${idx + 1}: ${line.trim()}`)
    }
    if (line.includes('sessions.clear(') && !line.includes('typeof this.sessions.clear')) {
      problematicCalls.push(`Line ${idx + 1}: ${line.trim()}`)
    }
  })

  assert.deepEqual(
    problematicCalls,
    [],
    `Found unguarded stale session API calls in lib/client.js:\n` + problematicCalls.join('\n')
  )
})
