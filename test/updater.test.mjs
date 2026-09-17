import test from 'node:test'
import assert from 'node:assert/strict'
import { isNewerVersion, isTrustedUpdateRequest, checkUpdateStatus, registerPluginUpdater } from '../lib/updater.js'

test('updater: isNewerVersion semantic version comparison with prereleases', () => {
  assert.equal(isNewerVersion('0.1.4', '0.1.5'), true)
  assert.equal(isNewerVersion('0.1.4', '0.2.0'), true)
  assert.equal(isNewerVersion('0.1.4', '1.0.0'), true)
  assert.equal(isNewerVersion('0.1.4', '0.1.4'), false)
  assert.equal(isNewerVersion('0.2.0', '0.1.4'), false)
  assert.equal(isNewerVersion('0.1.4', 'invalid'), false)

  // Prerelease comparisons (SemVer 2.0.0)
  assert.equal(isNewerVersion('0.2.0-beta.1', '0.2.0'), true)
  assert.equal(isNewerVersion('0.2.0', '0.2.0-beta.1'), false)
  assert.equal(isNewerVersion('0.2.0-alpha.1', '0.2.0-beta.1'), true)
  assert.equal(isNewerVersion('0.2.0-beta.1', '0.2.0-beta.2'), true)
  assert.equal(isNewerVersion('0.2.0-beta.2', '0.2.0-beta.1'), false)
  assert.equal(isNewerVersion('0.2.0-rc.1', '0.2.0-rc.2'), true)
  assert.equal(isNewerVersion('0.1.4', '0.2.0-alpha.1'), true)
})

test('updater: isTrustedUpdateRequest security checks fail-closed', () => {
  const validReq = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      'x-dsh-plugin-update': '1',
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      'sec-fetch-site': 'same-origin',
    },
  }
  assert.equal(isTrustedUpdateRequest(validReq), true)

  // Missing or wrong update header
  assert.equal(isTrustedUpdateRequest({ ...validReq, headers: { ...validReq.headers, 'x-dsh-plugin-update': '0' } }), false)
  assert.equal(isTrustedUpdateRequest({ ...validReq, headers: { host: '127.0.0.1:3000' } }), false)

  // Non-loopback remote address
  assert.equal(isTrustedUpdateRequest({ ...validReq, socket: { remoteAddress: '198.51.100.24' } }), false)

  // External origin
  assert.equal(isTrustedUpdateRequest({
    ...validReq,
    headers: { ...validReq.headers, origin: 'https://attacker.example.com' }
  }), false)

  // Origin host mismatch
  assert.equal(isTrustedUpdateRequest({
    ...validReq,
    headers: { ...validReq.headers, origin: 'http://localhost:8080' }
  }), false)
})

test('updater: checkUpdateStatus inspects package manifest', async () => {
  const manifestUrl = new URL('../package.json', import.meta.url)
  const status = await checkUpdateStatus(
    { packageName: '@goodandready/dsh-session-control', manifestUrl, registry: 'https://127.0.0.1:9999' },
    { profileName: 'test', profileDir: '/tmp/test' }
  )
  assert.equal(status.packageName, '@goodandready/dsh-session-control')
  assert.ok(status.currentVersion)
  assert.equal(status.latestCheckFailed, true)
  assert.equal(status.updateAvailable, false)
})

test('updater: registerPluginUpdater mounts route and rejects untrusted requests', async () => {
  let registeredHandler = null
  const fakeCtx = {
    webServer: {
      register(opts) {
        registeredHandler = opts.handler
        return () => {}
      }
    }
  }

  const manifestUrl = new URL('../package.json', import.meta.url)
  registerPluginUpdater(fakeCtx, {
    endpoint: '/api/dsh-session-control/update',
    packageName: '@goodandready/dsh-session-control',
    manifestUrl,
    registry: 'https://127.0.0.1:9999',
  })

  assert.ok(registeredHandler, 'Route handler must be registered')

  // Test GET status
  let resStatus = 0
  let resBody = ''
  const mockRes = {
    writeHead(code, headers) { resStatus = code },
    end(data) { resBody = data }
  }

  await registeredHandler({ method: 'GET' }, mockRes)
  assert.equal(resStatus, 200)
  assert.ok(resBody.includes('"packageName":"@goodandready/dsh-session-control"'))

  // Test POST untrusted
  await registeredHandler({
    method: 'POST',
    socket: { remoteAddress: '198.51.100.2' },
    headers: {}
  }, mockRes)
  assert.equal(resStatus, 403)
  assert.ok(resBody.includes('Rejected non-local'))

  // Test method not allowed
  await registeredHandler({ method: 'DELETE' }, mockRes)
  assert.equal(resStatus, 405)
})
