import test from 'node:test'
import assert from 'node:assert/strict'

// Pure guard implementation identical to lib/index.js
function guardRoute(req, res, expectedMethod) {
  if (req.method !== expectedMethod) {
    res.writeHead(405, { allow: expectedMethod, 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: `${expectedMethod} required` }))
    return false
  }
  const site = req.headers && req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'cross-site request refused' }))
    return false
  }
  return true
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(code, h) {
      this.statusCode = code
      this.headers = h
    },
    end(data) {
      this.body = data
    }
  }
}

test('guardRoute allows matching GET method without sec-fetch-site', () => {
  const res = mockRes()
  const ok = guardRoute({ method: 'GET', headers: {} }, res, 'GET')
  assert.equal(ok, true)
  assert.equal(res.statusCode, 200)
})

test('guardRoute allows matching POST method with same-origin sec-fetch-site', () => {
  const res = mockRes()
  const ok = guardRoute({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }, res, 'POST')
  assert.equal(ok, true)
  assert.equal(res.statusCode, 200)
})

test('guardRoute allows sec-fetch-site none (direct browser address bar navigation)', () => {
  const res = mockRes()
  const ok = guardRoute({ method: 'GET', headers: { 'sec-fetch-site': 'none' } }, res, 'GET')
  assert.equal(ok, true)
  assert.equal(res.statusCode, 200)
})

test('guardRoute rejects mismatched method with 405 Method Not Allowed', () => {
  const res = mockRes()
  const ok = guardRoute({ method: 'POST', headers: {} }, res, 'GET')
  assert.equal(ok, false)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'GET')
  assert.ok(res.body.includes('GET required'))
})

test('guardRoute rejects cross-site sec-fetch-site with 403 Forbidden', () => {
  const res = mockRes()
  const ok = guardRoute({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }, res, 'GET')
  assert.equal(ok, false)
  assert.equal(res.statusCode, 403)
  assert.ok(res.body.includes('cross-site request refused'))
})
