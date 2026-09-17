import test from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackAddress, isTrustedOrigin, guardRoute } from '../lib/guard.js'

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(code, h) {
      this.statusCode = code
      this.headers = h || {}
    },
    end(data) {
      this.body = data || ''
    }
  }
}

test('isLoopbackAddress classifies IPv4, IPv6, and localhost variants', () => {
  assert.equal(isLoopbackAddress('localhost'), true)
  assert.equal(isLoopbackAddress('LOCALHOST'), true)
  assert.equal(isLoopbackAddress('[::1]'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.0.1.1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.50'), false)
  assert.equal(isLoopbackAddress('10.0.0.1'), false)
  assert.equal(isLoopbackAddress(''), false)
  assert.equal(isLoopbackAddress(undefined), false)
  assert.equal(isLoopbackAddress(null), false)
})

test('isTrustedOrigin fail-closed on empty or malformed requests', () => {
  assert.equal(isTrustedOrigin(null), false)
  assert.equal(isTrustedOrigin(undefined), false)
  assert.equal(isTrustedOrigin({}), false)
  assert.equal(isTrustedOrigin({ headers: {} }), false)
  assert.equal(isTrustedOrigin({ headers: {}, socket: { remoteAddress: '192.168.1.100' } }), false)
})

test('guardRoute allows loopback address without explicit auth headers', () => {
  const res = mockRes()
  const ok = guardRoute({
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' }
  }, res, 'GET')

  assert.equal(ok, true)
  assert.equal(res.statusCode, 200)
})

test('guardRoute allows IPv6 loopback address (::1)', () => {
  const res = mockRes()
  const ok = guardRoute({
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '::1' }
  }, res, 'GET')

  assert.equal(ok, true)
  assert.equal(res.statusCode, 200)
})

test('guardRoute allows Bearer authorization token from external IP', () => {
  const res = mockRes()
  const ok = guardRoute({
    method: 'GET',
    headers: { authorization: 'Bearer test-token-12345' },
    socket: { remoteAddress: '192.168.1.50' }
  }, res, 'GET')

  assert.equal(ok, true)
  assert.equal(res.statusCode, 200)
})

test('guardRoute allows session cookie from external IP', () => {
  const res = mockRes()
  const ok = guardRoute({
    method: 'GET',
    headers: { cookie: 'dsh_token=xyz987; theme=dark' },
    socket: { remoteAddress: '192.168.1.50' }
  }, res, 'GET')

  assert.equal(ok, true)
  assert.equal(res.statusCode, 200)
})

test('guardRoute allows same-origin sec-fetch-site from external IP', () => {
  const res = mockRes()
  const ok = guardRoute({
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '192.168.1.50' }
  }, res, 'POST')

  assert.equal(ok, true)
  assert.equal(res.statusCode, 200)
})

test('guardRoute allows matching Origin and Host headers from external IP', () => {
  const res = mockRes()
  const ok = guardRoute({
    method: 'GET',
    headers: {
      origin: 'http://my-dsh.local:3000',
      host: 'my-dsh.local:3000'
    },
    socket: { remoteAddress: '192.168.1.50' }
  }, res, 'GET')

  assert.equal(ok, true)
  assert.equal(res.statusCode, 200)
})

test('guardRoute allows sec-fetch-site none when host header is present', () => {
  const res = mockRes()
  const ok = guardRoute({
    method: 'GET',
    headers: {
      'sec-fetch-site': 'none',
      host: '192.168.1.111:3000'
    },
    socket: { remoteAddress: '192.168.1.50' }
  }, res, 'GET')

  assert.equal(ok, true)
  assert.equal(res.statusCode, 200)
})

test('guardRoute rejects sec-fetch-site none when host header is missing', () => {
  const res = mockRes()
  const ok = guardRoute({
    method: 'GET',
    headers: {
      'sec-fetch-site': 'none'
    },
    socket: { remoteAddress: '192.168.1.50' }
  }, res, 'GET')

  assert.equal(ok, false)
  assert.equal(res.statusCode, 403)
  assert.ok(res.body.includes('untrusted request origin'))
})

test('guardRoute rejects mismatched method with 405 Method Not Allowed', () => {
  const res = mockRes()
  const ok = guardRoute({
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' }
  }, res, 'GET')

  assert.equal(ok, false)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'GET')
  assert.ok(res.body.includes('GET required'))
})

test('guardRoute rejects cross-site sec-fetch-site with 403 Forbidden', () => {
  const res = mockRes()
  const ok = guardRoute({
    method: 'GET',
    headers: {
      'sec-fetch-site': 'cross-site',
      host: '192.168.1.111:3000',
      origin: 'http://attacker.com'
    },
    socket: { remoteAddress: '192.168.1.50' }
  }, res, 'GET')

  assert.equal(ok, false)
  assert.equal(res.statusCode, 403)
  assert.ok(res.body.includes('untrusted request origin'))
})

test('guardRoute rejects external request without headers or credentials (fail-closed)', () => {
  const res = mockRes()
  const ok = guardRoute({
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '192.168.1.50' }
  }, res, 'GET')

  assert.equal(ok, false)
  assert.equal(res.statusCode, 403)
  assert.ok(res.body.includes('untrusted request origin'))
})
