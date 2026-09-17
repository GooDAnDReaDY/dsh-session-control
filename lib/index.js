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
  titleFromTranscript,
  transcriptToMarkdown,
  batchTranscriptToMarkdown,
} from './transcript.js'
import { sizeLevel, normalizeThresholds, DEFAULT_WARN_EVENTS, DEFAULT_DANGER_EVENTS } from './size.js'
import { registerPluginUpdater } from './updater.js'
import {
  buildHandoffExtract,
  buildSummaryRequest,
  buildSummaryDraft,
  summaryTextFromBlocks,
  SUMMARY_MAX_INPUT_CHARS,
} from './handoff.js'

export const name = '@goodandready/dsh-session-control'

/** Settings namespace. Matches settings.plugin.item card key. */
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
  pinned: z.array(z.string()).default([]),
  /**
   * Hidden sessions: reversible array of session IDs.
   * Custom hiding mechanism instead of core archive: core archive is irreversible
   * from the UI, whereas our hide state toggles in a single click.
   */
  hidden: z.array(z.string()).default([]),
  /**
   * Hide empty session rows (sessions without any user messages).
   * The active session is never hidden, even if empty, so the user never
   * loses the input target row they are about to type into.
   */
  hideBlank: z.boolean().default(true),
  /**
   * Tags: tag name mapped to an array of session IDs.
   * Replaces moving sessions between folders. Sessions cannot be moved
   * across workspaces because workspace membership is inferred from the host directory.
   * Tags exist solely in plugin state without altering core structures.
   */
  labels: z.dict(z.array(z.string())).default({}),
  /**
   * Event count from which a session gets a yellow "large" badge.
   *
   * The DSH conversation view is not virtualized, so a very large session can
   * freeze the browser tab during a long agent turn.
   */
  sizeWarnEvents: z.number().default(DEFAULT_WARN_EVENTS),
  /** Event count from which a session gets a red "dangerous" badge. */
  sizeDangerEvents: z.number().default(DEFAULT_DANGER_EVENTS),
  /** Provider id for the model-written handoff summary; empty disables it. */
  handoffProvider: z.string().default(''),
  /** Model id for the model-written handoff summary; empty disables it. */
  handoffModel: z.string().default(''),
  /** Character budget of the transcript tail handed to the summary model. */
  handoffMaxInputChars: z.number().default(SUMMARY_MAX_INPUT_CHARS),
  /** Timeout of the summary model call, in seconds. */
  handoffTimeoutSeconds: z.number().default(90),
})

/** How many session sizes one request may ask for. */
const SIZE_BATCH = 60

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
 * Read stored session log.
 *
 * Supports both modern DSH core handle-based interface (store.open + handle.read)
 * and legacy interface (resolveLog + readStoredLog).
 *
 * Distinguishes three outcomes to report accurate status:
 * session does not exist, log exists but core cannot parse it (legacy v0 format),
 * or success.
 *
 * @param store - Host session storage service.
 * @param sessionId - Target session ID.
 * @returns `{ missing, unreadable, messages }`.
 */
async function readTranscript(store, sessionId) {
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
        const readResult = await handle.read(0, undefined)
        const events = (readResult && readResult.events) || []
        return {
          missing: false,
          unreadable: events.length === 0,
          messages: transcriptFromEvents(events),
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
      return {
        missing: false,
        unreadable: events.length === 0,
        messages: transcriptFromEvents(events),
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

export function apply(ctx, config) {
  // Routes read live settings through this getter, so threshold and model
  // changes apply without a restart.
  let currentSettings = () => config || {}

  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(NS, Config, { base: config })
    currentSettings = () => {
      try {
        return (scope && typeof scope.get === 'function' && scope.get()) || config || {}
      } catch (unreadable) {
        return config || {}
      }
    }
  })

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

    const guardRoute = (req, res, expectedMethod) => {
      if (req.method !== expectedMethod) {
        res.writeHead(405, { allow: expectedMethod, 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: `${expectedMethod} required` }))
        return false
      }
      const site = req.headers && req.headers['sec-fetch-site']
      if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        json(res, 403, { ok: false, error: 'cross-site request refused' })
        return false
      }
      return true
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
              if (!guardRoute(req, res, 'GET')) return
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
              const read = await readTranscript(store, sessionId)
              if (read.missing) {
                json(res, 404, { ok: false, error: 'session not found' })
                return
              }
              const truncated = read.messages.length > TRANSCRIPT_LIMIT
              const shown = read.messages.slice(-TRANSCRIPT_LIMIT)
              if (url.searchParams.get('format') === 'md') {
                const title = url.searchParams.get('title') || sessionId
                const text = read.unreadable
                  ? '# ' +
                    title +
                    '\n\n> The core declines to read this log format.\n'
                  : transcriptToMarkdown(title, shown, {
                      truncated,
                      total: read.messages.length,
                    })
                res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
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
                total: read.messages.length,
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
              if (!guardRoute(req, res, 'GET')) return
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
              const titles = {}
              for (const sessionId of ids) {
                if (titleCache.has(sessionId)) {
                  titles[sessionId] = titleCache.get(sessionId)
                  continue
                }
                const read = await readTranscript(store, sessionId)
                const title =
                  read.missing || read.unreadable
                    ? ''
                    : titleFromTranscript(read.messages)
                titleCache.set(sessionId, title)
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
              if (!guardRoute(req, res, 'GET')) return
              const url = new URL(req.url, 'http://localhost')
              const ids = (url.searchParams.get('sessions') || '')
                .split(',')
                .map((id) => id.trim())
                .filter((id) => id !== '')
                .slice(0, 50)
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
              const items = []
              for (const sessionId of ids) {
                const read = await readTranscript(store, sessionId)
                if (read.missing || read.unreadable) continue
                const title = titleCache.get(sessionId) || sessionId
                items.push({
                  title,
                  messages: read.messages.slice(-TRANSCRIPT_LIMIT),
                  info: {
                    truncated: read.messages.length > TRANSCRIPT_LIMIT,
                    total: read.messages.length,
                  },
                })
              }
              const md = batchTranscriptToMarkdown(items)
              res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
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
              if (!guardRoute(req, res, 'GET')) return
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
              const s = currentSettings()
              const thresholds = normalizeThresholds(s.sizeWarnEvents, s.sizeDangerEvents)
              const sizes = {}
              await Promise.all(ids.map(async (sessionId) => {
                try {
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
              if (!guardRoute(req, res, 'GET')) return
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
              const read = await readTranscript(store, sessionId)
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
              if (!guardRoute(req, res, 'POST')) return
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
              const read = await readTranscript(store, sessionId)
              if (read.missing) {
                json(res, 404, { ok: false, error: 'session not found' })
                return
              }
              if (read.unreadable) {
                json(res, 422, { ok: false, error: 'the stored log of this session cannot be read' })
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
                  source: { kind: 'plugin', plugin: 'dsh-session-control' },
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
