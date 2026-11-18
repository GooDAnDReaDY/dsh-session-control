/**
 * Server-side entry of @goodandready/dsh-session-control.
 *
 * Houses configuration schemas (pins, hidden, tags) and read routes:
 * transcript decoding for archived sessions, inferred titles for sessions
 * without a stored title, and batch export of selected sessions.
 *
 * Why routes are needed: Archived sessions cannot be opened directly in the browser.
 * The client history window only attaches to the active ("on-stage") session,
 * and archived sessions cannot be active by core policy. Streaming `session/follow`
 * does not connect over plain HTTP, requiring a stream carrier, while `session/page`
 * responds with "failed to observe session" unless observed.
 *
 * However, the host provides a built-in channel: stored session logs can be read
 * without booting a live session. We read stored logs through this mechanism. Read-only.
 */
import z from '@deepseek-ai/schemastery'
import {
  transcriptFromEvents,
  parseTranscript,
  titleFromTranscript,
  transcriptToMarkdown,
  batchTranscriptToMarkdown,
} from './transcript.js'
import { sizeLevel, normalizeThresholds, DEFAULT_WARN_EVENTS, DEFAULT_DANGER_EVENTS } from './size.js'
import { registerPluginUpdater } from './updater.js'
import { registerSearchTool } from './search-tool.js'
import {
  resolveWorkspaceRecords,
  findWorkspace,
  workspaceHasSession,
  sessionMatchesWorkspacePath,
  checkSessionAccess,
} from './workspace.js'
import { isLoopbackAddress, isTrustedOrigin, guardRoute } from './guard.js'
// Route handler guard checking req.method and trusted origin fail-closed
import {
  buildHandoffExtract,
  buildSummaryRequest,
  buildSummaryDraft,
  summaryTextFromBlocks,
  SUMMARY_MAX_INPUT_CHARS,
  HANDOFF_SUMMARY_SOURCE,
} from './handoff.js'

export const name = '@goodandready/dsh-session-control'
export const inject = ['webServer', 'sessionPersistence']
export {
  isLoopbackAddress,
  isTrustedOrigin,
  guardRoute,
  registerSearchTool,
  parseTranscript,
  readTranscript,
  canRead,
  resolveWorkspaceRecords,
  findWorkspace,
  workspaceHasSession,
  sessionMatchesWorkspacePath,
  checkSessionAccess,
  TITLE_BATCH,
  SIZE_BATCH,
  EXPORT_BATCH,
  TRANSCRIPT_LIMIT,
  TAIL_EVENTS,
  HEAD_EVENTS,
}

/** Settings namespace. Matches the plugin settings card key. */
export const NS = 'dsh-session-control'

/** Message limit per single transcript request; intended for reading, not infinite scroll. */
const TRANSCRIPT_LIMIT = 400

/**
 * Batch limit for inferred titles per request.
 * The on-screen list is bounded by panel height; requesting more than 30
 * rows at once is unnecessary as they would not fit on screen.
 */
const TITLE_BATCH = 30

/**
 * Resolve `@deepseek-ai/dsh-tools` at most once per process.
 *
 * The package is an optional peer: cores without it must still load the whole
 * plugin, so a missing toolkit disables only the agent search tool.
 *
 * @param {object} ctx - Cordis context; its logger is the canonical log sink.
 * @returns the toolkit module, or `null` when the core does not ship it.
 */
let toolkitPromise
function loadToolkit(ctx) {
  if (toolkitPromise === undefined) {
    toolkitPromise = import('@deepseek-ai/dsh-tools').catch((missing) => {
      const logger = ctx && ctx.logger
      if (logger && typeof logger.warn === 'function') {
        logger.warn(
          '[dsh-session-control] @deepseek-ai/dsh-tools is unavailable; session_search stays off: '
            + String((missing && missing.message) || missing),
        )
      }
      return null
    })
  }
  return toolkitPromise
}

// Unwrap Volatile boxes before any caller reads a value
export function plainConfig(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(plainConfig)
  if (typeof value.get === 'function') return plainConfig(value.get())
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainConfig(v)]))
}

/**
 * Plugin configuration schema.
 * Settings reside in the plugin card (Settings -> Plugins -> Session Control);
 * they do not create a dedicated top-level menu section, which is reserved
 * for subsystem-level components like models or providers.
 */
export const Config = z.object({
  /**
   * Pinned sessions: user-ordered array of session IDs.
   * Pins are global across the panel rather than partitioned per folder:
   * users pin what they are currently focusing on, regardless of directory.
   */
  pinned: z.array(z.string()).default([]).extra('volatile', true),
  /**
   * Hidden sessions: reversible array of session IDs.
   * Custom hiding mechanism instead of core archive: core archive is irreversible
   * from the UI, whereas our hide state toggles in a single click.
   */
  hidden: z.array(z.string()).default([]).extra('volatile', true),
  /**
   * Hide empty session rows (sessions without any user messages).
   * The active session is never hidden, even if empty, so the user never
   * loses the input target row they are about to type into.
   */
  hideBlank: z.boolean().default(true).extra('volatile', true),
  /**
   * Tags: tag name mapped to an array of session IDs.
   * Replaces moving sessions between folders. Sessions cannot be moved
   * across workspaces because workspace membership is inferred from the host directory.
   * Tags exist solely in plugin state without altering core structures.
   */
  labels: z.dict(z.array(z.string())).default({}).extra('volatile', true),
  /**
   * Event count from which a session gets a yellow "large" badge.
   *
   * The DSH conversation view is not virtualized, so a very large session can
   * freeze the browser tab during a long agent turn.
   */
  sizeWarnEvents: z.number().default(DEFAULT_WARN_EVENTS).extra('volatile', true),
  /** Event count from which a session gets a red "dangerous" badge. */
  sizeDangerEvents: z.number().default(DEFAULT_DANGER_EVENTS).extra('volatile', true),
  /** Provider id for the model-written handoff summary; empty disables it. */
  handoffProvider: z.string().default('').extra('volatile', true),
  /** Model id for the model-written handoff summary; empty disables it. */
  handoffModel: z.string().default('').extra('volatile', true),
  /** Character budget of the transcript tail handed to the summary model. */
  handoffMaxInputChars: z.number().default(SUMMARY_MAX_INPUT_CHARS).extra('volatile', true),
  /** Timeout of the summary model call, in seconds. */
  handoffTimeoutSeconds: z.number().default(90).extra('volatile', true),
  /** Maximum matching sessions returned per session_search tool invocation. */
  searchMaxResults: z.number().default(20).extra('volatile', true),
  /** Maximum character length of the snippet extracted around best match. */
  searchSnippetLength: z.number().default(200).extra('volatile', true),
  /** Query timeout in milliseconds (cooperative deadline). */
  searchTimeoutMs: z.number().default(30000).extra('volatile', true),
})

/** How many session sizes one request may ask for. */
const SIZE_BATCH = 60

/**
 * How many sessions one batch export may carry.
 *
 * Exceeding it is never silent: the Markdown header states how many sessions
 * were requested and how many were exported.
 */
const EXPORT_BATCH = 50

/** Output token cap of the summary model call. */
const SUMMARY_MAX_TOKENS = 1500

/**
 * Read a JSON request body with a size cap.
 * @param req - incoming request.
 * @param limit - maximum body size in bytes.
 * @returns the parsed object.
 */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (bad) {
        reject(new Error('request body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * How many events a transcript read asks for.
 *
 * The storage handle supports a logical slice, so the tail of a huge session
 * is read without decompressing the whole log. The message cap below applies
 * after parsing, on top of this window.
 */
const TAIL_EVENTS = 800

/**
 * How many leading events a title read asks for.
 *
 * A session title comes from the first human message, which is near the start
 * of the log: reading the head keeps /titles cheap even for huge sessions.
 */
const HEAD_EVENTS = 60

/**
 * Read the event count of a session from metadata, without touching the log.
 *
 * @param store - Host session storage service.
 * @param sessionId - Target session ID.
 * @returns the logical event count when the backend can tell, else undefined.
 */
async function eventCountOf(store, sessionId) {
  if (!store || typeof store.stat !== 'function') return undefined
  try {
    const snap = await store.stat(sessionId)
    return typeof snap?.eventCount === 'number' ? snap.eventCount : undefined
  } catch (statErr) {
    void statErr
    return undefined
  }
}

/**
 * Read stored session log.
 *
 * Supports both modern DSH core handle-based interface (store.open + handle.read)
 * and legacy interface (resolveLog + readStoredLog).
 *
 * Reads a slice instead of the whole log: `mode: 'tail'` asks for the newest
 * events a transcript shows, `mode: 'head'` for the few events a title needs.
 * Distinguishes three outcomes to report accurate status:
 * session does not exist, log exists but core cannot parse it (legacy v0 format),
 * or success.
 *
 * @param store - Host session storage service.
 * @param sessionId - Target session ID.
 * @param options - `{ mode: 'tail' | 'head' | 'full', limit: number }`.
 * @returns `{ missing, unreadable, empty, messages, total, offset, truncated }`.
 */
async function readTranscript(store, sessionId, options = {}) {
  const mode = options.mode || 'tail'
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : TAIL_EVENTS
  try {
    // 1. Modern DSH core API (descriptor-based read)
    if (store !== undefined && typeof store.open === 'function') {
      let handle
      try {
        handle = await store.open(sessionId, 'read')
      } catch (err) {
        const msg = String((err && err.message) || err || '')
        if (
          (err && err.name === 'SessionPersistenceNotFoundError') ||
          (err && err.code === 'ENOENT') ||
          msg.includes('not found') ||
          msg.includes('declines')
        ) {
          return { missing: true, unreadable: false, messages: [] }
        }
        return { missing: false, unreadable: true, messages: [] }
      }
      if (!handle) return { missing: true, unreadable: false, messages: [] }
      try {
        let offset = 0
        let length = limit
        if (mode === 'tail') {
          const total = await eventCountOf(store, sessionId)
          if (typeof total === 'number' && total > limit) {
            offset = total - limit
          }
        } else if (mode === 'head') {
          length = limit
        } else {
          offset = 0
          length = undefined
        }
        const readResult = await handle.read(offset, length)
        const events = (readResult && readResult.events) || []
        const raw = typeof readResult === 'string' ? readResult : (typeof readResult?.raw === 'string' ? readResult.raw : null)
        const messages = raw !== null ? parseTranscript(raw) : transcriptFromEvents(events)
        const total = await eventCountOf(store, sessionId)
        return {
          missing: false,
          empty: events.length === 0 && (!raw || raw.trim().length === 0),
          unreadable: false,
          messages,
          events: events.length,
          offset,
          // Unknown total counts as "not truncated": never claim a fragment is whole.
          truncated: typeof total === 'number' ? offset > 0 || offset + events.length < total : false,
          total,
        }
      } finally {
        if (typeof handle.close === 'function') {
          try {
            await handle.close()
          } catch (closeErr) {
            void closeErr
          }
        }
      }
    }

    // 2. Fallback for earlier core builds: resolveLog + readStoredLog
    if (
      store !== undefined &&
      typeof store.resolveLog === 'function' &&
      typeof store.readStoredLog === 'function'
    ) {
      const path = await store.resolveLog(sessionId)
      if (path === undefined) return { missing: true, unreadable: false, messages: [] }
      const log = await store.readStoredLog(path, sessionId)
      const events = (log && log.events) || []
      const raw = typeof log === 'string' ? log : (typeof log?.raw === 'string' ? log.raw : null)
      const all = raw !== null ? parseTranscript(raw) : transcriptFromEvents(events)
      // The legacy surface has no slice: cut the parsed result, never the read.
      const messages = mode === 'head' ? all.slice(0, limit) : all.slice(-limit)
      return {
        missing: false,
        empty: events.length === 0 && (!raw || raw.trim().length === 0),
        unreadable: false,
        messages,
        events: events.length,
        total: events.length,
        offset: mode === 'head' ? 0 : Math.max(0, events.length - messages.length),
        truncated: all.length > messages.length,
      }
    }

    return { missing: false, unreadable: true, messages: [] }
  } catch (refused) {
    return { missing: false, unreadable: true, messages: [] }
  }
}

/**
 * Check if the backend storage service supports reading stored logs.
 *
 * Surface varies across core releases: descriptor-based open vs resolveLog + readStoredLog.
 * Checks feature availability dynamically instead of relying on version checks.
 *
 * @param store - Host session storage service.
 * @returns true if stored log reading is supported.
 */
function canRead(store) {
  return (
    store !== undefined &&
    store !== null &&
    (typeof store.open === 'function' ||
      (typeof store.resolveLog === 'function' &&
        typeof store.readStoredLog === 'function'))
  )
}



export function apply(ctx, rawConfig) {
  let activeConfig = rawConfig
  // Routes read live settings through this getter, unwrapping volatile boxes
  // lazily so threshold and model changes apply without a restart.
  let currentSettings = () => plainConfig(activeConfig || {})

  if (typeof ctx?.on === 'function') {
    try {
      ctx.on('loader/volatile-update', () => {
        // Volatile boxes are mutated in place by loader; plainConfig reads them lazily
      })
    } catch {
      // Safe fallback if ctx.on is unavailable
    }
  }

  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['tools', 'sessionQuery'], (tctx) => {
        // The toolkit is optional, so it is imported after the plugin half
        // that owns the sidebar is already alive.
        loadToolkit(tctx).then((kit) => {
          if (!kit || typeof kit.defineTool !== 'function') return
          try {
            registerSearchTool(tctx, currentSettings, kit.defineTool)
          } catch (registerErr) {
            const logger = tctx && tctx.logger
            if (logger && typeof logger.warn === 'function') {
              logger.warn('[dsh-session-control] session_search registration failed: ' + String(registerErr))
            }
          }
        })
      })
    } catch {
      // Safe fallback if inject is unsupported in mock or standalone
    }
  } else if (ctx?.tools && ctx?.sessionQuery) {
    loadToolkit(ctx).then((kit) => {
      if (!kit || typeof kit.defineTool !== 'function') return
      registerSearchTool(ctx, currentSettings, kit.defineTool)
    })
  }

  ctx.inject(['webServer', 'sessionPersistence'], (rctx) => {
    /**
     * Inferred titles cached in process memory.
     * The first user message in a session never changes, so cache invalidation
     * is not required during the host process lifetime.
     */
    const titleCache = new Map()

    const json = (res, code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }

    function resolveConnection() {
      try {
        if (rctx && typeof rctx.get === 'function') {
          return rctx.get('connection')
        }
      } catch (rctxErr) {
        void rctxErr
      }
      try {
        if (ctx && typeof ctx.get === 'function') {
          return ctx.get('connection')
        }
      } catch (ctxErr) {
        void ctxErr
      }
      return undefined
    }

    const guardOptions = {
      get connection() {
        return resolveConnection()
      },
    }



    rctx.effect(
      () =>
        registerPluginUpdater(rctx, {
          endpoint: '/api/dsh-session-control/update',
          packageName: '@goodandready/dsh-session-control',
          manifestUrl: new URL('../package.json', import.meta.url),
        }),
      'dsh-session-control: plugin updater route',
    )

    rctx.effect(
      () =>
        rctx.webServer.register({
          kind: 'exact',
          path: '/dsh-session-control/transcript',
          handler: async (req, res) => {
            try {
              if (!guardRoute(req, res, 'GET', guardOptions)) return
              const url = new URL(req.url, 'http://localhost')
              const sessionId = url.searchParams.get('session')
              if (sessionId === null || sessionId === '') {
                json(res, 400, { ok: false, error: 'session parameter is required' })
                return
              }
              const store = rctx.get('sessionPersistence')
              if (!canRead(store)) {
                json(res, 501, {
                  ok: false,
                  error: 'this session backend cannot read stored logs',
                })
                return
              }
              const workspaceId = url.searchParams.get('workspace') || req.headers['x-dsh-workspace']
              const access = await checkSessionAccess(sessionId, workspaceId, { rctx, ctx, store })
              if (!access.allowed) {
                json(res, access.status || (access.notFound ? 404 : 403), {
                  ok: false,
                  error: access.reason || 'session not accessible',
                })
                return
              }
              const read = await readTranscript(store, sessionId, { mode: 'tail' })
              if (read.missing) {
                json(res, 404, { ok: false, error: 'session not found' })
                return
              }
              // The read already carries a tail window; the message cap is a
              // second bound on what the viewer renders.
              const shown = read.messages.slice(-TRANSCRIPT_LIMIT)
              const total = typeof read.total === 'number' ? read.total : read.messages.length
              const truncated = read.truncated === true || read.messages.length > shown.length
              if (url.searchParams.get('format') === 'md') {
                const title = url.searchParams.get('title') || sessionId
                const text = read.unreadable
                  ? '# ' +
                    title +
                    '\n\n> The core declines to read this log format.\n'
                  : transcriptToMarkdown(title, shown, {
                      truncated,
                      total,
                    })
                res.writeHead(200, {
                'content-type': 'text/markdown; charset=utf-8',
                'content-disposition': 'attachment; filename="sessions-export.md"',
              })
                res.end(text)
                return
              }
              if (read.unreadable) {
                json(res, 200, {
                  ok: true,
                  sessionId,
                  unreadable: true,
                  total: 0,
                  truncated: false,
                  messages: [],
                })
                return
              }
              json(res, 200, {
                ok: true,
                sessionId,
                total,
                truncated,
                messages: shown,
              })
            } catch (failure) {
              json(res, 500, {
                ok: false,
                error: (failure && failure.message) || String(failure),
              })
            }
          },
        }),
      'dsh-session-control: transcript route',
    )

    rctx.effect(
      () =>
        rctx.webServer.register({
          kind: 'exact',
          path: '/dsh-session-control/titles',
          handler: async (req, res) => {
            try {
              if (!guardRoute(req, res, 'GET', guardOptions)) return
              const url = new URL(req.url, 'http://localhost')
              const ids = (url.searchParams.get('sessions') || '')
                .split(',')
                .map((id) => id.trim())
                .filter((id) => id !== '')
                .slice(0, TITLE_BATCH)
              if (ids.length === 0) {
                json(res, 400, { ok: false, error: 'sessions parameter is required' })
                return
              }
              const store = rctx.get('sessionPersistence')
              if (!canRead(store)) {
                json(res, 501, {
                  ok: false,
                  error: 'this session backend cannot read stored logs',
                })
                return
              }
              const workspaceId = url.searchParams.get('workspace') || req.headers['x-dsh-workspace']
              if (!workspaceId) {
                json(res, 400, { ok: false, error: 'workspace parameter is required' })
                return
              }
              const titles = {}
              for (const sessionId of ids) {
                // Every read route answers under the same workspace boundary:
                // a foreign or unknown workspace is rejected, never skipped.
                const access = await checkSessionAccess(sessionId, workspaceId, { rctx, ctx, store })
                if (!access.allowed) {
                  json(res, access.status || (access.notFound ? 404 : 403), {
                    ok: false,
                    error: access.reason || ('session ' + sessionId + ' not accessible'),
                  })
                  return
                }
                if (titleCache.has(sessionId)) {
                  titles[sessionId] = titleCache.get(sessionId)
                  continue
                }
                const read = await readTranscript(store, sessionId, { mode: 'head', limit: HEAD_EVENTS })
                const title =
                  read.missing || read.unreadable
                    ? ''
                    : titleFromTranscript(read.messages)
                if (title) titleCache.set(sessionId, title)
                titles[sessionId] = title
              }
              json(res, 200, { ok: true, titles })
            } catch (failure) {
              json(res, 500, {
                ok: false,
                error: (failure && failure.message) || String(failure),
              })
            }
          },
        }),
      'dsh-session-control: titles route',
    )

    rctx.effect(
      () =>
        rctx.webServer.register({
          kind: 'exact',
          path: '/dsh-session-control/export-batch',
          handler: async (req, res) => {
            try {
              if (!guardRoute(req, res, 'GET', guardOptions)) return
              const url = new URL(req.url, 'http://localhost')
              const requested = (url.searchParams.get('sessions') || '')
                .split(',')
                .map((id) => id.trim())
                .filter((id) => id !== '')
              if (requested.length === 0) {
                json(res, 400, { ok: false, error: 'sessions parameter is required' })
                return
              }
              // The selection may span several folders: the client sends the
              // workspace of each session so every id is checked against its own.
              const requestedWorkspaces = (url.searchParams.get('workspaces') || '')
                .split(',')
                .map((id) => id.trim())
                .filter((id) => id !== '')
              const fallbackWorkspace = url.searchParams.get('workspace') || req.headers['x-dsh-workspace']
              const store = rctx.get('sessionPersistence')
              if (!canRead(store)) {
                json(res, 501, {
                  ok: false,
                  error: 'this session backend cannot read stored logs',
                })
                return
              }
              const ids = requested.slice(0, EXPORT_BATCH)
              const truncated = requested.length > ids.length
              const items = []
              for (let index = 0; index < ids.length; index += 1) {
                const sessionId = ids[index]
                const workspaceId = requestedWorkspaces[index] || fallbackWorkspace
                const access = await checkSessionAccess(sessionId, workspaceId, { rctx, ctx, store })
                if (!access.allowed) {
                  json(res, access.status || 403, {
                    ok: false,
                    error: access.reason || ('session ' + sessionId + ' not accessible'),
                  })
                  return
                }
                const read = await readTranscript(store, sessionId, { mode: 'tail' })
                if (read.missing || read.unreadable) continue
                const title = titleCache.get(sessionId) || sessionId
                items.push({
                  title,
                  messages: read.messages.slice(-TRANSCRIPT_LIMIT),
                  info: {
                    truncated: read.truncated === true || read.messages.length > TRANSCRIPT_LIMIT,
                    total: typeof read.total === 'number' ? read.total : read.messages.length,
                  },
                })
              }
              const md = batchTranscriptToMarkdown(items, {
                truncated,
                requested: requested.length,
                exported: items.length,
              })
              res.writeHead(200, {
                'content-type': 'text/markdown; charset=utf-8',
                'content-disposition': 'attachment; filename="sessions-export.md"',
              })
              res.end(md)
            } catch (failure) {
              json(res, 500, {
                ok: false,
                error: (failure && failure.message) || String(failure),
              })
            }
          },
        }),
      'dsh-session-control: export batch route',
    )

    // #39: session sizes for the rows on screen. Reads metadata only through
    // `sessionPersistence.stat`, never decompresses a log.
    rctx.effect(
      () =>
        rctx.webServer.register({
          kind: 'exact',
          path: '/dsh-session-control/sizes',
          handler: async (req, res) => {
            try {
              if (!guardRoute(req, res, 'GET', guardOptions)) return
              const url = new URL(req.url, 'http://localhost')
              const ids = (url.searchParams.get('sessions') || '')
                .split(',')
                .map((id) => id.trim())
                .filter((id) => id !== '')
                .slice(0, SIZE_BATCH)
              if (ids.length === 0) {
                json(res, 400, { ok: false, error: 'sessions parameter is required' })
                return
              }
              const store = rctx.get('sessionPersistence')
              if (store === undefined || typeof store.stat !== 'function') {
                json(res, 501, { ok: false, error: 'this session backend cannot report sizes' })
                return
              }
              const workspaceId = url.searchParams.get('workspace') || req.headers['x-dsh-workspace']
              if (!workspaceId) {
                json(res, 400, { ok: false, error: 'workspace parameter is required' })
                return
              }
              const s = currentSettings()
              const thresholds = normalizeThresholds(s.sizeWarnEvents, s.sizeDangerEvents)
              const sizes = {}
              await Promise.all(ids.map(async (sessionId) => {
                try {
                  const access = await checkSessionAccess(sessionId, workspaceId, { rctx, ctx, store })
                  if (!access.allowed) { sizes[sessionId] = null; return }
                  const snap = await store.stat(sessionId)
                  if (!snap) { sizes[sessionId] = null; return }
                  const events = typeof snap.eventCount === 'number' ? snap.eventCount : undefined
                  sizes[sessionId] = {
                    events: events === undefined ? null : events,
                    bytes: typeof snap.sizeBytes === 'number' ? snap.sizeBytes : null,
                    level: sizeLevel(events, thresholds.warn, thresholds.danger),
                  }
                } catch (unreadable) {
                  sizes[sessionId] = null
                }
              }))
              json(res, 200, { ok: true, thresholds, sizes })
            } catch (failure) {
              json(res, 500, { ok: false, error: (failure && failure.message) || String(failure) })
            }
          },
        }),
      'dsh-session-control: sizes route',
    )

    // #40: instant handoff extract, assembled without a model.
    rctx.effect(
      () =>
        rctx.webServer.register({
          kind: 'exact',
          path: '/dsh-session-control/handoff',
          handler: async (req, res) => {
            try {
              if (!guardRoute(req, res, 'GET', guardOptions)) return
              const url = new URL(req.url, 'http://localhost')
              const sessionId = url.searchParams.get('session')
              if (!sessionId) {
                json(res, 400, { ok: false, error: 'session parameter is required' })
                return
              }
              const store = rctx.get('sessionPersistence')
              if (!canRead(store)) {
                json(res, 501, { ok: false, error: 'this session backend cannot read stored logs' })
                return
              }
              const workspaceId = url.searchParams.get('workspace') || req.headers['x-dsh-workspace']
              const access = await checkSessionAccess(sessionId, workspaceId, { rctx, ctx, store })
              if (!access.allowed) {
                json(res, access.status || (access.notFound ? 404 : 403), {
                  ok: false,
                  error: access.reason || 'session not accessible',
                })
                return
              }
              const read = await readTranscript(store, sessionId, { mode: 'tail' })
              if (read.missing) {
                json(res, 404, { ok: false, error: 'session not found' })
                return
              }
              const text = buildHandoffExtract({
                title: url.searchParams.get('title') || '',
                cwd: url.searchParams.get('cwd') || '',
                sessionId,
                messages: read.messages,
                unreadable: read.unreadable,
              })
              json(res, 200, { ok: true, mode: 'extract', text })
            } catch (failure) {
              json(res, 500, { ok: false, error: (failure && failure.message) || String(failure) })
            }
          },
        }),
      'dsh-session-control: handoff extract route',
    )

    // #41: model-written handoff summary. POST only and same-origin only,
    // because unlike every other route of this plugin it spends model tokens.
    rctx.effect(
      () =>
        rctx.webServer.register({
          kind: 'exact',
          path: '/dsh-session-control/handoff-summary',
          handler: async (req, res) => {
            try {
              if (!guardRoute(req, res, 'POST', guardOptions)) return
              const url = new URL(req.url, 'http://localhost')
              const body = await readJsonBody(req)
              const sessionId = typeof body.session === 'string' ? body.session : ''
              if (!sessionId) {
                json(res, 400, { ok: false, error: 'session is required' })
                return
              }
              const s = currentSettings()
              const provider = String(s.handoffProvider || '').trim()
              const model = String(s.handoffModel || '').trim()
              if (!provider || !model) {
                json(res, 409, { ok: false, error: 'summary model is not configured' })
                return
              }
              const llm = rctx.get('llm')
              if (llm === undefined || typeof llm.stream !== 'function') {
                json(res, 501, { ok: false, error: 'model service is unavailable' })
                return
              }
              let llmKit
              try {
                llmKit = await import('@deepseek-ai/dsh-llm')
              } catch (missing) {
                json(res, 501, { ok: false, error: 'model message helpers are unavailable' })
                return
              }
              const store = rctx.get('sessionPersistence')
              if (!canRead(store)) {
                json(res, 501, { ok: false, error: 'this session backend cannot read stored logs' })
                return
              }
              const workspaceId = (typeof body.workspace === 'string' ? body.workspace : null) || url.searchParams.get('workspace') || req.headers['x-dsh-workspace']
              const access = await checkSessionAccess(sessionId, workspaceId, { rctx, ctx, store })
              if (!access.allowed) {
                json(res, access.status || (access.notFound ? 404 : 403), {
                  ok: false,
                  error: access.reason || 'session not accessible',
                })
                return
              }
              const read = await readTranscript(store, sessionId, { mode: 'tail' })
              if (read.missing) {
                json(res, 404, { ok: false, error: 'session not found' })
                return
              }
              if (read.unreadable) {
                json(res, 422, { ok: false, error: 'the stored log of this session cannot be read' })
                return
              }
              if (read.empty || read.messages.length === 0) {
                json(res, 400, { ok: false, error: 'session has no messages to summarize' })
                return
              }
              const meta = {
                title: typeof body.title === 'string' ? body.title : '',
                cwd: typeof body.cwd === 'string' ? body.cwd : '',
                sessionId,
              }
              const request = buildSummaryRequest({
                ...meta,
                messages: read.messages,
                maxInputChars: s.handoffMaxInputChars,
              })
              const seconds = Number(s.handoffTimeoutSeconds) > 0 ? Number(s.handoffTimeoutSeconds) : 90
              const signal = AbortSignal.timeout(seconds * 1000)
              const assembler = new llmKit.BlockAssembler()
              const stream = llm.stream({
                provider,
                model,
                system: request.system,
                messages: [llmKit.createUserMessage({
                  content: [{ type: 'text', text: request.text }],
                  source: HANDOFF_SUMMARY_SOURCE,
                })],
                maxTokens: SUMMARY_MAX_TOKENS,
                purpose: 'session-handoff-summary',
                signal,
              })
              for await (const chunk of stream) {
                signal.throwIfAborted()
                assembler.push(chunk)
              }
              const finish = assembler.finish
              if (finish && (finish.reason === 'error' || finish.error)) {
                const e = finish.error || finish
                throw new Error(String((e && e.message) || 'model call failed'))
              }
              const summary = summaryTextFromBlocks(assembler.blocks())
              json(res, 200, {
                ok: true,
                mode: 'summary',
                truncated: request.truncated,
                text: buildSummaryDraft({ ...meta, summary, truncated: request.truncated }),
              })
            } catch (failure) {
              const timedOut = failure && (failure.name === 'TimeoutError' || failure.name === 'AbortError')
              json(res, timedOut ? 504 : 500, {
                ok: false,
                error: timedOut ? 'summary model timed out' : ((failure && failure.message) || String(failure)),
              })
            }
          },
        }),
      'dsh-session-control: handoff summary route',
    )
  })
}
