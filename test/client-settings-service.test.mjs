import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const clientPath = new URL("../lib/client.js", import.meta.url);
const clientSrc = fs.readFileSync(clientPath, "utf8");

test("compatibility: client fiber does not require or wait for settingsScope (#58)", () => {
  assert.equal(
    clientSrc.includes("'settingsScope'"),
    false,
    "lib/client.js must not contain string literal 'settingsScope'"
  );
  assert.equal(
    clientSrc.includes('"settingsScope"'),
    false,
    'lib/client.js must not contain string literal "settingsScope"'
  );
});

test("compatibility: client declares configForms in UI inject and queries namespace (#58)", () => {
  assert.match(
    clientSrc,
    /ctx\.inject\(\s*\[\s*'locale',\s*'configForms'\s*\]/,
    "lib/client.js must inject locale and configForms"
  );
  assert.match(
    clientSrc,
    /configForms\.get\(\s*NS\s*\)/,
    "lib/client.js must query configForms.get(NS)"
  );
});

function loadClientModule() {
  let loaded = null;
  const windowMock = {
    __ModuleLoader__: {
      load: (decl) => { loaded = decl; },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  };

  const context = vm.createContext({
    window: windowMock,
    document: { head: { appendChild: () => {} }, createElement: () => ({ dataset: {} }) },
    console,
    setTimeout,
    clearTimeout,
    AbortController,
  });

  vm.runInContext(clientSrc, context);

  const fakeRequire = (spec) => {
    if (spec === "react") {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (init) => [typeof init === "function" ? init() : init, () => {}],
        useEffect: () => {},
        useCallback: (fn) => fn,
        useMemo: (fn) => (typeof fn === "function" ? fn() : fn),
        useRef: (init) => ({ current: init }),
        useSyncExternalStore: (sub, snap) => snap(),
      };
    }
    if (spec === "@deepseek-ai/cordis") {
      return {
        Service: class Service {
          constructor(ctx, name) {
            this.ctx = ctx;
            this.name = name;
          }
        },
      };
    }
    return {};
  };

  return loaded.factory(fakeRequire);
}

test("client lifecycle: fiber activates and registers UI slots with configForms", () => {
  const modExports = loadClientModule();

  let injectedChildDeps = null;
  const registeredSlots = {};

  const mockSessions = {
    list: { getSnapshot: () => ({ byId: {}, phase: "ready" }), subscribe: () => () => {} },
    search: async () => ({ ok: true, value: [] }),
  };
  const mockWorkspaces = {
    list: { getSnapshot: () => ({ items: [], phase: "ready" }), subscribe: () => () => {} },
  };

  const mockScope = {
    subscribe: () => () => {},
    getSnapshot: () => ({
      status: "ready",
      value: { pinned: ["sess-1"], hideBlank: true },
      writable: true,
    }),
    set: async () => {},
  };

  const mockCtx = {
    effect: (fn) => fn(),
    get: (name) => {
      if (name === "sessions") return mockSessions;
      if (name === "workspaces") return mockWorkspaces;
      return null;
    },
    remote: { directoryPicker: {}, $host: {} },
    slots: { provideRoot: () => {} },
    inject: (deps, cb) => {
      injectedChildDeps = [...deps];
      const uictx = {
        effect: (fn) => fn(),
        locale: { register: () => {} },
        slots: {
          entries: () => [],
          subscribe: () => () => {},
          inject: (_name, fn) => fn(),
          register: (decl, comp) => {
            registeredSlots[decl.name] = { decl, comp };
          },
        },
        remote: { $host: {} },
        on: () => () => {},
        configForms: {
          get: (ns) => mockScope,
        },
      };
      cb(uictx);
    },
  };

  modExports.apply(mockCtx);

  assert.deepEqual(injectedChildDeps, ["locale", "configForms"]);
  assert.ok(registeredSlots["sidebar.workspaces"], "sidebar.workspaces must register");
  assert.ok(registeredSlots["conversation.hero.workspace"], "conversation.hero.workspace must register");
  assert.ok(registeredSlots["plugins.item"], "plugins.item must register");
  assert.ok(registeredSlots["plugins.row.config"], "plugins.row.config must register");
  assert.ok(registeredSlots["settings.plugin.item"], "settings.plugin.item must register");
  assert.ok(registeredSlots["conversation.input.dock"], "conversation.input.dock must register");
});

test("SettingsCard: reads configForms ready snapshot, supports summary and unavailable states", async () => {
  const modExports = loadClientModule();
  const registeredSlots = {};

  const mockSessions = {
    list: { getSnapshot: () => ({ byId: {}, phase: "ready" }), subscribe: () => () => {} },
    search: async () => ({ ok: true, value: [] }),
  };
  const mockWorkspaces = {
    list: { getSnapshot: () => ({ items: [], phase: "ready" }), subscribe: () => () => {} },
  };

  let savedKey = null;
  let savedVal = null;
  const mockReadyScope = {
    subscribe: () => () => {},
    getSnapshot: () => ({
      status: "ready",
      value: {
        pinned: ["sess-1", "sess-2"],
        hidden: ["sess-3"],
        hideBlank: false,
        labels: { project: ["sess-1"] },
        sizeWarnEvents: 1200,
        sizeDangerEvents: 2400,
        handoffProvider: "openai",
        handoffModel: "gpt-4o",
      },
      writable: true,
    }),
    set: async (k, v) => {
      savedKey = k;
      savedVal = v;
    },
  };

  const mockCtx = {
    effect: (fn) => fn(),
    get: (name) => {
      if (name === "sessions") return mockSessions;
      if (name === "workspaces") return mockWorkspaces;
      return null;
    },
    remote: { directoryPicker: {}, $host: {} },
    slots: { provideRoot: () => {} },
    inject: (deps, cb) => {
      cb({
        effect: (fn) => fn(),
        locale: { register: () => {} },
        slots: {
          entries: () => [],
          subscribe: () => () => {},
          inject: (_name, fn) => fn(),
          register: (decl, comp) => {
            registeredSlots[decl.name] = { decl, comp };
          },
        },
        remote: { $host: {} },
        on: () => () => {},
        configForms: { get: () => mockReadyScope },
      });
    },
  };

  modExports.apply(mockCtx);

  const SettingsCard = registeredSlots["settings.plugin.item"].comp;

  // 1. Ready state render
  const readyView = SettingsCard({
    t: (k, vars) => k + (vars ? JSON.stringify(vars) : ""),
    ctx: { configForms: { get: () => mockReadyScope } },
    view: "page",
  });
  assert.equal(readyView.type, "div");

  // 2. Summary state render
  const summaryView = SettingsCard({
    t: (k) => k,
    ctx: { configForms: { get: () => mockReadyScope } },
    view: "summary",
  });
  assert.equal(summaryView.props.className, "dsc-card-sub");

  // 3. Unavailable state render
  const mockUnavailScope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: "unavailable", value: {} }),
    set: async () => {},
  };
  const unavailView = SettingsCard({
    t: (k) => k,
    ctx: { configForms: { get: () => mockUnavailScope } },
    view: "page",
  });
  assert.equal(unavailView.type, "div");

  // 4. Missing configForms service render
  const missingServiceView = SettingsCard({
    t: (k) => k,
    ctx: {},
    view: "page",
  });
  assert.equal(missingServiceView.type, "div");

  // 5. Test saving capability on scope
  await mockReadyScope.set("hideBlank", true);
  assert.equal(savedKey, "hideBlank");
  assert.equal(savedVal, true);
});
