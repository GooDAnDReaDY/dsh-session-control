import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Config, plainConfig, apply, inject } from "../lib/index.js";

const indexPath = new URL("../lib/index.js", import.meta.url);
const indexSource = fs.readFileSync(indexPath, "utf8");

const clientPath = new URL("../lib/client.js", import.meta.url);
const clientSource = fs.readFileSync(clientPath, "utf8");

test("Issue #64 / #68: host inject does not request removed settings service", () => {
  assert.ok(!inject.includes("settings"), 'inject must not request removed settings service');
  assert.ok(inject.includes("webServer"), "inject must include webServer");
});

test("Issue #64 / #66 / #68: lib/index.js never calls settings.register", () => {
  assert.equal(
    /settings\s*\.\s*register\s*\(/.test(indexSource),
    false,
    "lib/index.js must not call settings.register"
  );
});

test("Issue #64: Config schema marks user-facing leaves as volatile", () => {
  const fields = Config.dict;
  assert.ok(fields, "Config must be a schema object");
  const expectedVolatile = [
    "pinned",
    "hidden",
    "hideBlank",
    "labels",
    "sizeWarnEvents",
    "sizeDangerEvents",
    "handoffProvider",
    "handoffModel",
    "handoffMaxInputChars",
    "handoffTimeoutSeconds",
  ];
  for (const fieldName of expectedVolatile) {
    const fieldSchema = fields[fieldName];
    assert.ok(fieldSchema, 'field ' + fieldName + ' must exist in Config schema');
    assert.equal(
      fieldSchema.meta?.volatile,
      true,
      'field ' + fieldName + ' must have meta.volatile === true'
    );
  }
});

test("Issue #64: plainConfig correctly unwraps Volatile boxes and deep objects", () => {
  let warnVal = 1000;
  const volatileBox = {
    get: () => warnVal,
    [Symbol.for("cosmokit.volatile")]: true,
  };
  const wrapped = {
    sizeWarnEvents: volatileBox,
    pinned: ["sess-1"],
    nested: {
      inner: {
        get: () => "unwrapped",
      },
    },
  };

  const unwrapped1 = plainConfig(wrapped);
  assert.equal(unwrapped1.sizeWarnEvents, 1000);
  assert.equal(unwrapped1.nested.inner, "unwrapped");
  assert.deepEqual(unwrapped1.pinned, ["sess-1"]);

  warnVal = 1500;
  const unwrapped2 = plainConfig(wrapped);
  assert.equal(unwrapped2.sizeWarnEvents, 1500);
});

test("Issue #64 / #66: apply activates and reads live settings without settings.register", async () => {
  let warnVal = 800;
  const volatileWarn = {
    get: () => warnVal,
  };

  const registeredRoutes = {};
  const mockWebServer = {
    register: (route) => {
      registeredRoutes[route.path] = route.handler;
      return () => {};
    },
  };

  const mockPersistence = {
    stat: async (id) => ({ eventCount: 900, sizeBytes: 1024 }),
  };

  const eventHandlers = {};
  const mockCtx = {
    on: (evt, cb) => {
      (eventHandlers[evt] ??= []).push(cb);
    },
    inject: (deps, cb) => {
      if (deps.includes("webServer") && deps.includes("sessionPersistence")) {
        const rctx = {
          get: (name) => {
            if (name === "sessionPersistence") return mockPersistence;
            return null;
          },
          webServer: mockWebServer,
          effect: (fn) => fn(),
        };
        cb(rctx);
      }
    },
  };

  const initialConfig = {
    sizeWarnEvents: volatileWarn,
    sizeDangerEvents: 2000,
  };

  apply(mockCtx, initialConfig);

  const sizesHandler = registeredRoutes["/dsh-session-control/sizes"];
  assert.ok(sizesHandler, "/dsh-session-control/sizes route must be registered");

  const req = {
    method: "GET",
    url: "/dsh-session-control/sizes?sessions=sess-1",
    headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  let resStatus = null;
  let resData = null;
  const res = {
    writeHead: (s) => { resStatus = s; },
    end: (d) => { resData = JSON.parse(d); },
  };

  await sizesHandler(req, res);
  assert.equal(resStatus, 200);
  assert.equal(resData.ok, true);
  assert.equal(resData.sizes["sess-1"].level, "warn");

  warnVal = 1000;
  for (const cb of eventHandlers["loader/volatile-update"] || []) {
    cb();
  }

  const req2 = {
    method: "GET",
    url: "/dsh-session-control/sizes?sessions=sess-1",
    headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  await sizesHandler(req2, res);
  assert.equal(resStatus, 200);
  assert.equal(resData.ok, true);
  assert.equal(resData.sizes["sess-1"].level, "ok");
});

test("Issue #64 / #68: client exports.inject includes configForms and omits settings.plugin.item", () => {
  assert.match(
    clientSource,
    /exports\.inject\s*=\s*\[[^\]]*'configForms'[^\]]*\]/,
    "lib/client.js must include 'configForms' in exports.inject"
  );
  assert.equal(
    clientSource.includes("'settings.plugin.item'"),
    false,
    "lib/client.js must not register or reference retired slot 'settings.plugin.item'"
  );
});
