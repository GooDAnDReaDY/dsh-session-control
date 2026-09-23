import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const clientPath = new URL('../lib/client.js', import.meta.url)
const clientSrc = fs.readFileSync(clientPath, 'utf8')

function loadClientWithStorage(initialStorage = {}) {
  let loaded = null
  const storageMap = new Map(Object.entries(initialStorage))
  const storageListeners = new Set()

  const windowMock = {
    __ModuleLoader__: {
      load: (decl) => { loaded = decl },
    },
    localStorage: {
      getItem: (k) => storageMap.get(k) || null,
      setItem: (k, v) => {
        storageMap.set(k, String(v))
        for (const l of storageListeners) l({ key: k, newValue: String(v) })
      },
    },
    addEventListener: (evt, l) => {
      if (evt === 'storage') storageListeners.add(l)
    },
    removeEventListener: (evt, l) => {
      if (evt === 'storage') storageListeners.delete(l)
    },
  }

  const context = vm.createContext({
    window: windowMock,
    document: { head: { appendChild: () => {} }, createElement: () => ({ dataset: {} }) },
    console,
    setTimeout,
    clearTimeout,
    AbortController,
  })

  vm.runInContext(clientSrc, context)

  const fakeRequire = (spec) => {
    if (spec === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
        useEffect: () => {},
        useCallback: (fn) => fn,
        useMemo: (fn) => (typeof fn === 'function' ? fn() : fn),
        useRef: (init) => ({ current: init }),
        useSyncExternalStore: (sub, snap) => snap(),
      }
    }
    if (spec === '@deepseek-ai/cordis') {
      return {
        Service: class Service {
          constructor(ctx, name) {
            this.ctx = ctx
            this.name = name
          }
        },
      }
    }
    return {}
  }

  return { exports: loaded.factory(fakeRequire), storageMap }
}

test('localStorage fallback: useSettings activates local mode when host scope is unavailable', () => {
  const initial = { 'dsc.settings': JSON.stringify({ pinned: ['p1', 'p2'], hideBlank: false }) }
  const { exports } = loadClientWithStorage(initial)

  const registeredSlots = {}
  const mockCtx = {
    effect: (fn) => fn(),
    get: () => ({ list: { getSnapshot: () => ({ items: [], byId: {}, phase: 'ready' }), subscribe: () => () => {} } }),
    remote: { directoryPicker: {}, $host: {} },
    slots: {
      provideRoot: () => {},
      inject: (_name, fn) => fn(),
      register: (decl, comp) => { registeredSlots[decl.name] = { decl, comp } },
      entries: () => [],
      subscribe: () => () => {},
    },
    inject: (deps, cb) => {
      cb({
        effect: (fn) => fn(),
        locale: { register: () => {} },
        slots: {
          inject: (_name, fn) => fn(),
          register: (decl, comp) => { registeredSlots[decl.name] = { decl, comp } },
          entries: () => [],
          subscribe: () => () => {},
        },
        remote: { $host: {} }, get: () => ({}),
        on: () => () => {},
        configForms: {
          // Emulate non-loopback memory mode or missing host settings
          get: () => ({
            getSnapshot: () => ({ status: 'unavailable', value: {} }),
            subscribe: () => () => {},
            set: async () => {},
          }),
        },
      })
    },
  }

  exports.apply(mockCtx)

  const Panel = registeredSlots['sidebar.workspaces'].comp
  const injected = registeredSlots['sidebar.workspaces'].decl.inject()

  const panelTree = Panel({
    t: (k) => k,
    configForms: injected.configForms,
    useWorkspaces: () => [],
    useSessions: () => ({ byId: {} }),
    useDirectoryFlow: () => false, renderSlot: () => null,
  })

  assert.equal(panelTree.type, 'div')
  // Verify that error.settings is NOT present in the tree when local fallback is active
  const children = panelTree.children || []
  const hasSettingsError = children.some(
    (c) => c && c.props && c.props.className === 'dsc-error' && c.children && c.children.includes('error.settings')
  )
  assert.equal(hasSettingsError, false, 'error.settings banner must not show when local storage fallback is ready')
})

test('Issue #55: client search includes derived titles in matching predicate', () => {
  // Directly verify that matches logic checks derivedTitle
  assert.match(
    clientSrc,
    /derivedTitle\.toLowerCase\(\)\.includes\(text\)/,
    'lib/client.js must include derivedTitle in matches check'
  )
})

test('Issue #53: client title batching limit is aligned to 30 and clears unreturned IDs', () => {
  assert.match(
    clientSrc,
    /want\.length\s*>=\s*30/,
    'lib/client.js must cap title batch to 30 items'
  )
  assert.match(
    clientSrc,
    /if\s*\(\s*body\.titles\[id\]\s*===\s*undefined\s*\)\s*askedRef\.current\.delete\(id\)/,
    'lib/client.js must remove unreturned IDs from askedRef'
  )
})

test('Issue #56: export-batch route includes Content-Disposition attachment header', () => {
  const indexSrc = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(
    indexSrc,
    /content-disposition':\s*'attachment;\s*filename="sessions-export\.md"/,
    'lib/index.js must set Content-Disposition on export-batch route'
  )
})

test('Issue #54: index.js readTranscript sets empty: true rather than unreadable: true for empty logs', () => {
  const indexSrc = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(
    indexSrc,
    /unreadable:\s*events\.length\s*===\s*0/,
    'readTranscript must not set unreadable based on events.length === 0'
  )
  assert.match(
    indexSrc,
    /empty:\s*events\.length\s*===\s*0/,
    'readTranscript must set empty: events.length === 0'
  )
})
