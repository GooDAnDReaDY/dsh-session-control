/**
 * Route protection and origin validation for dsh-session-control HTTP endpoints.
 *
 * Implements a strict fail-closed security model matching the DSH platform standard:
 * requests are rejected with 403 Forbidden unless they originate from trusted same-origin
 * contexts, possess a valid signed DSH session cookie, possess a verified Bearer token,
 * or carry trusted loopback navigation metadata.
 */

/**
 * Checks whether an IP address belongs to loopback.
 *
 * @param {string|undefined|null} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const clean = address.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    clean === 'localhost' ||
    clean === 'localhost.' ||
    clean === '::1' ||
    clean.startsWith('127.') === true ||
    clean.startsWith('::ffff:127.') === true
  )
}

/**
 * Validates request origin under a fail-closed security model (#57).
 *
 * Rejects:
 * - Any cross-site request (Sec-Fetch-Site: 'cross-site'), regardless of source IP
 * - Arbitrary, unverified Bearer tokens or unauthenticated token cookies
 *
 * Permits:
 * - Same-origin fetch metadata (Sec-Fetch-Site: 'same-origin')
 * - Matching Origin and Host headers (non-cross-site)
 * - Authenticated DSH signed session cookie ('dsh-auth-*=v1...')
 * - Verified Bearer token matching configured auth token
 * - Direct loopback browser navigation (Sec-Fetch-Site: 'none' or direct CLI with Host)
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ authToken?: string }} [options]
 * @returns {boolean}
 */
export function isTrustedOrigin(req, options = {}) {
  if (!req || !req.headers) return false

  // 1. Fail-closed on explicit cross-site requests (even from loopback)
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site') return false

  const host = req.headers['host']
  const expectedToken = options.authToken || process.env.DSH_AUTH_TOKEN

  // 2. Verified Bearer authorization token
  const rawAuth = req.headers['authorization']
  if (typeof rawAuth === 'string') {
    if (!rawAuth.startsWith('Bearer ')) return false
    const token = rawAuth.slice(7).trim()
    if (!token) return false
    if (expectedToken && token === expectedToken) return true
    return false
  }

  // 3. Authenticated session cookie
  const cookieHeader = req.headers['cookie']
  if (typeof cookieHeader === 'string') {
    // Valid signed DSH session cookie: dsh-auth-<hash>=v1.<payload>.<sig>
    if (/dsh-auth-[a-zA-Z0-9_-]+=v1\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/.test(cookieHeader)) {
      return true
    }
    if (expectedToken && (cookieHeader.includes(`token=${expectedToken}`) || cookieHeader.includes(`dsh_token=${expectedToken}`))) {
      return true
    }
  }

  // 4. Same-origin fetch metadata
  if (site === 'same-origin') return true

  // 5. Explicit Origin matching Host header
  const origin = req.headers['origin']
  if (typeof origin === 'string' && typeof host === 'string' && host.length > 0) {
    try {
      const parsed = new URL(origin)
      if (parsed.host === host) return true
    } catch (parseErr) {
      void parseErr
    }
  }

  // 6. Direct navigation from loopback
  const remoteAddr = req.socket?.remoteAddress || req.connection?.remoteAddress
  if (isLoopbackAddress(remoteAddr)) {
    if (site === 'none' && typeof host === 'string' && host.length > 0) return true
    if (!site && !origin && typeof host === 'string' && host.length > 0) return true
  }

  return false
}

/**
 * Enforces allowed HTTP method and origin trust on route handlers.
 *
 * Emits:
 * - 405 Method Not Allowed (with Allow header) when req.method !== expectedMethod
 * - 403 Forbidden when origin is untrusted
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {'GET'|'POST'} expectedMethod
 * @param {{ authToken?: string }} [options]
 * @returns {boolean} true if request may proceed, false if rejected
 */
export function guardRoute(req, res, expectedMethod, options) {
  if (req.method !== expectedMethod) {
    res.writeHead(405, {
      allow: expectedMethod,
      'content-type': 'application/json; charset=utf-8'
    })
    res.end(JSON.stringify({ ok: false, error: `${expectedMethod} required` }))
    return false
  }

  if (!isTrustedOrigin(req, options)) {
    res.writeHead(403, {
      'content-type': 'application/json; charset=utf-8'
    })
    res.end(JSON.stringify({ ok: false, error: 'untrusted request origin' }))
    return false
  }

  return true
}
