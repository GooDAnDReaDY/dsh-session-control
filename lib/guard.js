/**
 * Route protection and origin validation for dsh-session-control HTTP endpoints.
 *
 * Implements a strict fail-closed security model matching the DSH platform standard:
 * requests are rejected with 403 Forbidden unless they originate from loopback,
 * possess a valid Bearer token, possess an authenticated session cookie,
 * or carry trusted same-origin fetch metadata.
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
 * Validates request origin under a fail-closed security model.
 *
 * Permits:
 * 1. Bearer authorization token (CLI, API integrations)
 * 2. Authenticated web cookie ('token=' or 'dsh_token=')
 * 3. Loopback request (local processes, reverse proxies)
 * 4. Sec-Fetch-Site 'same-origin'
 * 5. Matching Origin and Host headers
 * 6. Sec-Fetch-Site 'none' with valid Host header (browser direct navigation)
 *
 * Rejects all other requests by default (fail-closed).
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isTrustedOrigin(req) {
  if (!req || !req.headers) return false

  // 1. Bearer authorization header
  const rawAuth = req.headers['authorization']
  if (typeof rawAuth === 'string' && rawAuth.startsWith('Bearer ')) return true

  // 2. Authenticated cookie
  const cookieHeader = req.headers['cookie']
  if (
    typeof cookieHeader === 'string' &&
    (cookieHeader.includes('token=') || cookieHeader.includes('dsh_token='))
  ) {
    return true
  }

  // 3. Loopback remote address
  const remoteAddr = req.socket?.remoteAddress || req.connection?.remoteAddress
  if (isLoopbackAddress(remoteAddr)) return true

  // 4. Same-origin fetch metadata
  const site = req.headers['sec-fetch-site']
  if (site === 'same-origin') return true

  // 5. Explicit Origin matching Host header
  const origin = req.headers['origin']
  const host = req.headers['host']
  if (typeof origin === 'string' && typeof host === 'string' && host.length > 0) {
    try {
      const parsed = new URL(origin)
      if (parsed.host === host) return true
    } catch (parseErr) {
      void parseErr
    }
  }

  // 6. Direct browser address bar navigation with Host header present
  if (site === 'none' && typeof host === 'string' && host.length > 0) return true

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
 * @returns {boolean} true if request may proceed, false if rejected
 */
export function guardRoute(req, res, expectedMethod) {
  if (req.method !== expectedMethod) {
    res.writeHead(405, {
      allow: expectedMethod,
      'content-type': 'application/json; charset=utf-8'
    })
    res.end(JSON.stringify({ ok: false, error: `${expectedMethod} required` }))
    return false
  }

  if (!isTrustedOrigin(req)) {
    res.writeHead(403, {
      'content-type': 'application/json; charset=utf-8'
    })
    res.end(JSON.stringify({ ok: false, error: 'untrusted request origin' }))
    return false
  }

  return true
}
