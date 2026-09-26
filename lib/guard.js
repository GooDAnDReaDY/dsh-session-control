/**
 * Route protection and origin validation for dsh-session-control HTTP endpoints.
 *
 * Implements a strict fail-closed security model matching the DSH platform standard:
 * requests are rejected with 403 Forbidden unless they originate from trusted loopback
 * contexts, possess a verified Bearer token matching configured auth secrets, or are
 * authenticated and admitted through the canonical DSH connection service (#57).
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
 * - External (non-loopback) requests with forged same-origin / Origin / cookie headers
 * - Arbitrary, unverified Bearer tokens or unauthenticated token cookies
 *
 * Permits:
 * - Verified Bearer token matching configured auth token
 * - Requests authenticated and admitted by DSH connection service (connection.requestRejection)
 * - Direct loopback browser navigation (Sec-Fetch-Site: 'none' or same-origin with Host)
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ authToken?: string, connection?: { requestRejection?: (req: any) => number | undefined } }} [options]
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

  // 3. Authenticated session token via cookie matching expected server secret
  const cookieHeader = req.headers['cookie']
  if (expectedToken && typeof cookieHeader === 'string') {
    if (cookieHeader.includes(`token=${expectedToken}`) || cookieHeader.includes(`dsh_token=${expectedToken}`)) {
      return true
    }
  }

  // 4. Delegate to DSH connection trust and authentication layer if present (#57)
  if (options.connection && typeof options.connection.requestRejection === 'function') {
    const rejection = options.connection.requestRejection(req)
    return rejection === undefined
  }

  // 5. Direct navigation or fetch from verified loopback address
  const remoteAddr = req.socket?.remoteAddress || req.connection?.remoteAddress
  if (isLoopbackAddress(remoteAddr)) {
    if (site === 'same-origin' && typeof host === 'string' && host.length > 0) return true
    if (site === 'none' && typeof host === 'string' && host.length > 0) return true
    const origin = req.headers['origin']
    if (typeof origin === 'string' && typeof host === 'string' && host.length > 0) {
      try {
        const parsed = new URL(origin)
        if (parsed.host === host) return true
      } catch (parseErr) {
        void parseErr
      }
    }
    if (!site && !origin && typeof host === 'string' && host.length > 0) return true
  }

  // 6. External non-loopback clients fail closed (#57)
  return false
}

/**
 * Enforces allowed HTTP method and origin trust on route handlers.
 *
 * Emits:
 * - 405 Method Not Allowed (with Allow header) when req.method !== expectedMethod
 * - 403 Forbidden when origin is untrusted or cross-site
 * - 401 Unauthorized when core authentication rejects unauthenticated credentials
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {'GET'|'POST'} expectedMethod
 * @param {{ authToken?: string, connection?: { requestRejection?: (req: any) => number | undefined } }} [options]
 * @returns {boolean} true if request may proceed, false if rejected
 */
export function guardRoute(req, res, expectedMethod, options = {}) {
  if (req.method !== expectedMethod) {
    res.writeHead(405, {
      allow: expectedMethod,
      'content-type': 'application/json; charset=utf-8'
    })
    res.end(JSON.stringify({ ok: false, error: `${expectedMethod} required` }))
    return false
  }

  if (req.headers && req.headers['sec-fetch-site'] === 'cross-site') {
    res.writeHead(403, {
      'content-type': 'application/json; charset=utf-8'
    })
    res.end(JSON.stringify({ ok: false, error: 'untrusted request origin' }))
    return false
  }

  // Direct Bearer token validation matching configured secret
  const expectedToken = options?.authToken || process.env.DSH_AUTH_TOKEN
  const rawAuth = req.headers?.['authorization']
  if (typeof rawAuth === 'string') {
    if (rawAuth.startsWith('Bearer ')) {
      const token = rawAuth.slice(7).trim()
      if (expectedToken && token === expectedToken) {
        return true
      }
    }
    res.writeHead(403, {
      'content-type': 'application/json; charset=utf-8'
    })
    res.end(JSON.stringify({ ok: false, error: 'untrusted request origin' }))
    return false
  }

  // Core connection authentication verification (#57)
  if (options?.connection && typeof options.connection.requestRejection === 'function') {
    const rejection = options.connection.requestRejection(req)
    if (rejection !== undefined) {
      res.writeHead(rejection, {
        'content-type': 'application/json; charset=utf-8'
      })
      res.end(JSON.stringify({ ok: false, error: rejection === 401 ? 'unauthorized' : 'untrusted request origin' }))
      return false
    }
    return true
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
