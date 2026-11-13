import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Resolve known workspaces from the running harness services or disk storage.
 *
 * Checks in-memory workspaceRegistry / workspaces service first.
 * If unavailable, falls back to reading $DSH_HOME/storages/workspace.json.
 *
 * @param {object} rctx - Injected Cordis context.
 * @param {object} ctx - Root Cordis context.
 * @returns {Map<string, { id: string, path: string, sessionIds: Set<string> }>}
 */
export function resolveWorkspaceRecords(rctx, ctx) {
  const map = new Map()

  function ingestItem(item) {
    if (!item) return
    const id = String(item.id || item.workspaceId || '')
    const p = String(item.path || '')
    if (!id && !p) return
    const key = id || p
    const existing = map.get(key) || {
      id: id || key,
      path: p,
      sessionIds: new Set(),
    }
    const rawSessions = item.sessionIds
    if (Array.isArray(rawSessions)) {
      for (const s of rawSessions) existing.sessionIds.add(String(s))
    } else if (rawSessions && typeof rawSessions[Symbol.iterator] === 'function') {
      for (const s of rawSessions) existing.sessionIds.add(String(s))
    }
    map.set(id || key, existing)
    if (p) map.set(p, existing)
  }

  // 1. In-memory service (workspaceRegistry or workspaces)
  let candidate = null
  try {
    if (rctx && typeof rctx.get === 'function') {
      candidate = rctx.get('workspaceRegistry') || rctx.get('workspaces')
    }
  } catch (e) {
    void e
  }
  if (!candidate && ctx && typeof ctx.get === 'function') {
    try {
      candidate = ctx.get('workspaceRegistry') || ctx.get('workspaces')
    } catch (e) {
      void e
    }
  }

  if (candidate) {
    try {
      if (typeof candidate.list === 'function') {
        const list = candidate.list()
        if (Array.isArray(list)) {
          for (const item of list) ingestItem(item)
        }
      } else if (candidate.list && typeof candidate.list.getSnapshot === 'function') {
        const snap = candidate.list.getSnapshot()
        if (Array.isArray(snap?.items)) {
          for (const item of snap.items) ingestItem(item)
        }
      }
    } catch (e) {
      void e
    }
  }

  // 2. Fallback to host storage file if in-memory list is empty
  if (map.size === 0) {
    try {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
      const storageFile = path.join(home, 'storages', 'workspace.json')
      if (fs.existsSync(storageFile)) {
        const raw = fs.readFileSync(storageFile, 'utf8')
        const data = JSON.parse(raw)
        const workspaces = data?.tables?.workspaces || {}
        for (const [id, val] of Object.entries(workspaces)) {
          if (!val) continue
          ingestItem({
            id,
            path: val.path,
            sessionIds: val.sessionIds,
          })
        }
      }
    } catch (e) {
      void e
    }
  }

  return map
}

/**
 * Check whether a workspace contains a specific session ID.
 *
 * Normalizes both stripped ("abc") and prefixed ("session-abc") variants.
 *
 * @param {object} ws - Workspace record with sessionIds set.
 * @param {string} sessionId - Session identifier.
 * @returns {boolean}
 */
export function workspaceHasSession(ws, sessionId) {
  if (!ws || !ws.sessionIds) return false
  const raw = String(sessionId)
  const stripped = raw.replace(/^session-/, '')
  const prefixed = 'session-' + stripped
  return ws.sessionIds.has(raw) || ws.sessionIds.has(stripped) || ws.sessionIds.has(prefixed)
}

/**
 * Check if the stored session cwd matches the target workspace path.
 *
 * Used as fallback for newly created sessions whose IDs may not yet be flushed
 * to the workspace sessionIds array.
 *
 * @param {object} store - Session persistence store.
 * @param {string} sessionId - Session identifier.
 * @param {string} wsPath - Expected workspace path.
 * @returns {Promise<boolean>}
 */
export async function sessionMatchesWorkspacePath(store, sessionId, wsPath) {
  if (!store || !wsPath) return false
  try {
    if (typeof store.open === 'function') {
      const handle = await store.open(sessionId, 'read').catch(() => null)
      if (handle) {
        try {
          const cwd = handle.header?.cwd
          if (typeof cwd === 'string' && cwd === wsPath) {
            return true
          }
        } finally {
          if (typeof handle.close === 'function') {
            await handle.close().catch(() => null)
          }
        }
      }
    }
  } catch (e) {
    void e
  }
  return false
}

/**
 * Enforce workspace isolation boundary for session access.
 *
 * Prevents unauthorized cross-workspace transcript inspection over LAN
 * or loopback bridges.
 *
 * @param {string} sessionId - Target session ID.
 * @param {string} workspaceId - Workspace ID or path claimed by request.
 * @param {object} context - Context containing rctx, ctx, store.
 * @returns {Promise<{ allowed: boolean, status?: number, reason?: string, workspace?: object }>}
 */
export async function checkSessionAccess(sessionId, workspaceId, { rctx, ctx, store }) {
  if (!workspaceId) {
    return { allowed: false, status: 400, reason: 'workspace parameter is required' }
  }
  const map = resolveWorkspaceRecords(rctx, ctx)
  const targetWs = map.get(workspaceId) || Array.from(map.values()).find((w) => w.path === workspaceId || w.id === workspaceId)
  if (!targetWs) {
    return { allowed: false, status: 404, notFound: true, reason: 'workspace not found' }
  }
  if (workspaceHasSession(targetWs, sessionId)) {
    return { allowed: true, workspace: targetWs }
  }
  if (await sessionMatchesWorkspacePath(store, sessionId, targetWs.path)) {
    return { allowed: true, workspace: targetWs }
  }
  return { allowed: false, status: 403, reason: 'session does not belong to specified workspace' }
}
