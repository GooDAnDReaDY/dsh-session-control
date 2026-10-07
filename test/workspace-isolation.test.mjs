import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolveWorkspaceRecords,
  workspaceHasSession,
  sessionMatchesWorkspacePath,
  checkSessionAccess,
  apply,
} from '../lib/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('cordis.patch.yml contains zero Cyrillic characters (#70)', () => {
  const patchPath = path.resolve(__dirname, '../cordis.patch.yml')
  const content = fs.readFileSync(patchPath, 'utf8')
  const cyrillicRegex = /[\u0400-\u04FF]/
  const violations = content
    .split('\n')
    .map((line, idx) => ({ line: idx + 1, text: line.trim() }))
    .filter((entry) => cyrillicRegex.test(entry.text))

  assert.deepEqual(violations, [], 'cordis.patch.yml must not contain any Cyrillic characters')
})

test('workspaceHasSession matches exact, stripped and prefixed session IDs', () => {
  const ws = {
    id: 'ws-alpha',
    path: '/path/to/project-alpha',
    sessionIds: new Set(['session-abc-123', 'xyz-456']),
  }

  assert.equal(workspaceHasSession(ws, 'session-abc-123'), true)
  assert.equal(workspaceHasSession(ws, 'abc-123'), true)
  assert.equal(workspaceHasSession(ws, 'xyz-456'), true)
  assert.equal(workspaceHasSession(ws, 'session-xyz-456'), true)
  assert.equal(workspaceHasSession(ws, 'session-not-found'), false)
  assert.equal(workspaceHasSession(null, 'abc'), false)
})

test('sessionMatchesWorkspacePath validates cwd against store handle header', async () => {
  const mockStore = {
    open: async (id) => {
      if (id === 'sess-open') {
        return {
          header: { cwd: '/workspace/dir' },
          close: async () => {},
        }
      }
      throw new Error('not found')
    },
  }

  const matches = await sessionMatchesWorkspacePath(mockStore, 'sess-open', '/workspace/dir')
  assert.equal(matches, true)

  const mismatches = await sessionMatchesWorkspacePath(mockStore, 'sess-open', '/other/dir')
  assert.equal(mismatches, false)

  const fails = await sessionMatchesWorkspacePath(mockStore, 'sess-missing', '/workspace/dir')
  assert.equal(fails, false)
})

test('checkSessionAccess enforces workspace boundary (#69)', async () => {
  const mockWorkspaceRegistry = {
    list: () => [
      { id: 'ws-1', path: '/home/user/project-1', sessionIds: ['sess-100', 'sess-101'] },
      { id: 'ws-2', path: '/home/user/project-2', sessionIds: ['sess-200'] },
    ],
  }

  const rctx = {
    get: (name) => (name === 'workspaceRegistry' ? mockWorkspaceRegistry : null),
  }

  // 1. Missing workspace parameter -> 400
  const missing = await checkSessionAccess('sess-100', '', { rctx })
  assert.equal(missing.allowed, false)
  assert.equal(missing.status, 400)
  assert.match(missing.reason, /workspace parameter is required/)

  // 2. Unknown workspace -> 404
  const unknown = await checkSessionAccess('sess-100', 'ws-unknown', { rctx })
  assert.equal(unknown.allowed, false)
  assert.equal(unknown.status, 404)
  assert.match(unknown.reason, /workspace not found/)

  // 3. Foreign workspace traversal -> 403
  const foreign = await checkSessionAccess('sess-100', 'ws-2', { rctx })
  assert.equal(foreign.allowed, false)
  assert.equal(foreign.status, 403)
  assert.match(foreign.reason, /session does not belong to specified workspace/)

  // 4. Authorized workspace access -> 200 (allowed)
  const ok = await checkSessionAccess('sess-100', 'ws-1', { rctx })
  assert.equal(ok.allowed, true)
  assert.equal(ok.workspace.id, 'ws-1')

  // 5. Authorized via workspace path instead of ID -> allowed
  const okByPath = await checkSessionAccess('sess-100', '/home/user/project-1', { rctx })
  assert.equal(okByPath.allowed, true)
})

test('HTTP routes enforce workspace isolation and fail-closed (#69)', async () => {
  const mockWorkspaces = {
    list: () => [
      { id: 'ws-alice', path: '/alice/dir', sessionIds: ['sess-alice-1'] },
      { id: 'ws-bob', path: '/bob/dir', sessionIds: ['sess-bob-1'] },
    ],
  }

  const mockStore = {
    open: async (id) => ({
      header: { cwd: id === 'sess-alice-1' ? '/alice/dir' : '/bob/dir' },
      read: async () => ({
        events: [
          { type: 'user/message', time: 1, data: { message: { role: 'user', content: [{ type: 'text', text: 'Hello from session ' + id }] } } },
        ],
      }),
      close: async () => {},
    }),
    stat: async () => ({ eventCount: 10, sizeBytes: 256 }),
  }

  const registeredRoutes = {}
  const mockWebServer = {
    register: (route) => {
      registeredRoutes[route.path] = route.handler
      return () => {}
    },
  }

  const mockCtx = {
    on: () => {},
    inject: (deps, cb) => {
      const rctx = {
        get: (name) => {
          if (name === 'sessionPersistence') return mockStore
          if (name === 'workspaceRegistry') return mockWorkspaces
          return null
        },
        webServer: mockWebServer,
        effect: (fn) => fn(),
      }
      cb(rctx)
    },
  }

  apply(mockCtx, {})

  const mockResponse = () => {
    let statusCode = 200
    let body = ''
    return {
      writeHead: (code) => { statusCode = code },
      end: (data) => { body = data },
      get status() { return statusCode },
      get json() {
        try { return JSON.parse(body) } catch { return body }
      },
    }
  }

  const loopbackReq = (url, method = 'GET') => ({
    method,
    url,
    headers: { host: '127.0.0.1:3000' },
    socket: { remoteAddress: '127.0.0.1' },
  })

  // /transcript
  const transcriptHandler = registeredRoutes['/dsh-session-control/transcript']
  assert.ok(transcriptHandler)

  // A. Request without workspace -> 400
  const res1 = mockResponse()
  await transcriptHandler(loopbackReq('/dsh-session-control/transcript?session=sess-alice-1'), res1)
  assert.equal(res1.status, 400)
  assert.equal(res1.json.ok, false)

  // B. Foreign workspace -> 403
  const res2 = mockResponse()
  await transcriptHandler(loopbackReq('/dsh-session-control/transcript?session=sess-alice-1&workspace=ws-bob'), res2)
  assert.equal(res2.status, 403)
  assert.equal(res2.json.ok, false)
  assert.match(res2.json.error, /session does not belong/)

  // C. Legitimate workspace -> 200
  const res3 = mockResponse()
  await transcriptHandler(loopbackReq('/dsh-session-control/transcript?session=sess-alice-1&workspace=ws-alice'), res3)
  assert.equal(res3.status, 200)
  assert.equal(res3.json.ok, true)
  assert.equal(res3.json.sessionId, 'sess-alice-1')

  // /export-batch
  const exportHandler = registeredRoutes['/dsh-session-control/export-batch']
  assert.ok(exportHandler)

  // A. Export batch with cross-workspace session -> 403
  const resExpForeign = mockResponse()
  await exportHandler(loopbackReq('/dsh-session-control/export-batch?sessions=sess-alice-1,sess-bob-1&workspace=ws-alice'), resExpForeign)
  assert.equal(resExpForeign.status, 403)
  assert.equal(resExpForeign.json.ok, false)

  // B. Export batch with matching workspace -> 200
  const resExpOk = mockResponse()
  await exportHandler(loopbackReq('/dsh-session-control/export-batch?sessions=sess-alice-1&workspace=ws-alice'), resExpOk)
  assert.equal(resExpOk.status, 200)
  assert.match(resExpOk.json, /Hello from session sess-alice-1/)

  // /handoff
  const handoffHandler = registeredRoutes['/dsh-session-control/handoff']
  assert.ok(handoffHandler)

  const resHandoffForeign = mockResponse()
  await handoffHandler(loopbackReq('/dsh-session-control/handoff?session=sess-alice-1&workspace=ws-bob'), resHandoffForeign)
  assert.equal(resHandoffForeign.status, 403)
  assert.equal(resHandoffForeign.json.ok, false)

  const resHandoffOk = mockResponse()
  await handoffHandler(loopbackReq('/dsh-session-control/handoff?session=sess-alice-1&workspace=ws-alice'), resHandoffOk)
  assert.equal(resHandoffOk.status, 200)
  assert.equal(resHandoffOk.json.ok, true)
})
