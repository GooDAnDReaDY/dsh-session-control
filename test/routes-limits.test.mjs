import test from 'node:test'
import assert from 'node:assert/strict'
import {
  transcriptFromEvents,
  titleFromTranscript,
  transcriptToMarkdown,
  batchTranscriptToMarkdown,
} from '../lib/transcript.js'

// Route parameters and limits matching lib/index.js
const TITLE_BATCH = 30
const SIZE_BATCH = 50
const EXPORT_BATCH = 50
const TRANSCRIPT_LIMIT = 400

function canRead(store) {
  return (
    store !== undefined &&
    store !== null &&
    (typeof store.open === 'function' ||
      (typeof store.resolveLog === 'function' &&
        typeof store.readStoredLog === 'function'))
  )
}

async function readTranscript(store, sessionId) {
  try {
    if (store !== undefined && typeof store.open === 'function') {
      let handle
      try {
        handle = await store.open(sessionId, 'read')
      } catch (err) {
        const msg = String((err && err.message) || err || '')
        if (
          (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) ||
          msg.includes('not found') ||
          msg.includes('ENOENT')
        ) {
          return { missing: true, unreadable: false, messages: [] }
        }
        return { missing: false, unreadable: true, messages: [] }
      }
      try {
        const parsed = await handle.read()
        const events = Array.isArray(parsed && parsed.events) ? parsed.events : []
        return {
          missing: false,
          unreadable: false,
          messages: transcriptFromEvents(events),
        }
      } catch (unreadable) {
        return { missing: false, unreadable: true, messages: [] }
      } finally {
        if (typeof handle.close === 'function') {
          try {
            await handle.close()
          } catch (closeErr) {}
        }
      }
    }
    return { missing: true, unreadable: false, messages: [] }
  } catch (err) {
    return { missing: false, unreadable: true, messages: [] }
  }
}

// Simulated route handlers mirroring lib/index.js logic
async function handleTitlesRoute(store, querySessions) {
  if (!querySessions) {
    return { status: 400, body: { ok: false, error: 'sessions parameter is required' } }
  }
  const ids = querySessions
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, TITLE_BATCH)

  if (ids.length === 0) {
    return { status: 400, body: { ok: false, error: 'sessions parameter is required' } }
  }
  if (!canRead(store)) {
    return { status: 501, body: { ok: false, error: 'this session backend cannot read stored logs' } }
  }

  const out = {}
  for (const id of ids) {
    const read = await readTranscript(store, id)
    if (!read.missing && !read.unreadable && read.messages.length > 0) {
      const title = titleFromTranscript(read.messages)
      if (title) out[id] = title
    }
  }
  return { status: 200, body: { ok: true, titles: out } }
}

async function handleExportBatchRoute(store, querySessions) {
  if (!querySessions) {
    return { status: 400, body: { ok: false, error: 'sessions parameter is required' } }
  }
  const ids = querySessions
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, EXPORT_BATCH)

  if (ids.length === 0) {
    return { status: 400, body: { ok: false, error: 'sessions parameter is required' } }
  }
  if (!canRead(store)) {
    return { status: 501, body: { ok: false, error: 'this session backend cannot read stored logs' } }
  }

  const sessions = []
  for (const id of ids) {
    const read = await readTranscript(store, id)
    sessions.push({
      id,
      missing: Boolean(read.missing),
      unreadable: Boolean(read.unreadable),
      messages: read.messages.slice(-TRANSCRIPT_LIMIT),
      truncated: read.messages.length > TRANSCRIPT_LIMIT,
    })
  }
  const markdown = batchTranscriptToMarkdown(sessions)
  return { status: 200, body: { ok: true, count: sessions.length, sessions, markdown } }
}

async function handleSizesRoute(store, querySessions) {
  if (!querySessions) {
    return { status: 400, body: { ok: false, error: 'sessions parameter is required' } }
  }
  const ids = querySessions
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, SIZE_BATCH)

  if (ids.length === 0) {
    return { status: 400, body: { ok: false, error: 'sessions parameter is required' } }
  }
  if (!store || typeof store.getStoredSizes !== 'function') {
    return { status: 501, body: { ok: false, error: 'this session backend cannot report sizes' } }
  }

  const sizes = await store.getStoredSizes(ids)
  return { status: 200, body: { ok: true, sizes } }
}

// --- Tests for Issue #36 ---

test('titles route: returns 501 when store lacks reader capabilities', async () => {
  const res = await handleTitlesRoute({}, 'session-1,session-2')
  assert.equal(res.status, 501)
  assert.equal(res.body.ok, false)
  assert.match(res.body.error, /cannot read stored logs/)
})

test('export-batch route: returns 501 when store lacks reader capabilities', async () => {
  const res = await handleExportBatchRoute(null, 'session-1')
  assert.equal(res.status, 501)
  assert.equal(res.body.ok, false)
  assert.match(res.body.error, /cannot read stored logs/)
})

test('sizes route: returns 501 when store lacks size reporting', async () => {
  const res = await handleSizesRoute({ open: async () => {} }, 'session-1')
  assert.equal(res.status, 501)
  assert.equal(res.body.ok, false)
  assert.match(res.body.error, /cannot report sizes/)
})

test('routes return 400 when session parameter is empty or missing', async () => {
  const store = { open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }) }
  assert.equal((await handleTitlesRoute(store, '')).status, 400)
  assert.equal((await handleTitlesRoute(store, ',,,')).status, 400)
  assert.equal((await handleExportBatchRoute(store, null)).status, 400)
  assert.equal((await handleSizesRoute(store, undefined)).status, 400)
})

test('titles route: truncates batch to TITLE_BATCH (30) items', async () => {
  const visited = []
  const store = {
    open: async (id) => {
      visited.push(id)
      return {
        read: async () => ({
          events: [
            { type: 'user/message', time: 1, data: { message: { role: 'user', content: [{ type: 'text', text: `Prompt for ${id}` }] } } }
          ]
        }),
        close: async () => {}
      }
    }
  }
  const input = Array.from({ length: 45 }, (_, i) => `s_${i + 1}`).join(',')
  const res = await handleTitlesRoute(store, input)
  assert.equal(res.status, 200)
  assert.equal(visited.length, TITLE_BATCH)
  assert.equal(Object.keys(res.body.titles).length, TITLE_BATCH)
  assert.equal(res.body.titles['s_1'], 'Prompt for s_1')
  assert.equal(res.body.titles['s_30'], 'Prompt for s_30')
  assert.equal(res.body.titles['s_31'], undefined)
})

test('export-batch route: truncates batch to EXPORT_BATCH (50) items', async () => {
  const visited = []
  const store = {
    open: async (id) => {
      visited.push(id)
      return {
        read: async () => ({
          events: [
            { type: 'user/message', time: 1, data: { message: { role: 'user', content: [{ type: 'text', text: `Hello ${id}` }] } } }
          ]
        }),
        close: async () => {}
      }
    }
  }
  const input = Array.from({ length: 65 }, (_, i) => `exp_${i + 1}`).join(',')
  const res = await handleExportBatchRoute(store, input)
  assert.equal(res.status, 200)
  assert.equal(visited.length, EXPORT_BATCH)
  assert.equal(res.body.sessions.length, EXPORT_BATCH)
  assert.equal(res.body.count, EXPORT_BATCH)
})

test('sizes route: truncates batch to SIZE_BATCH (50) items', async () => {
  let passedIds = []
  const store = {
    getStoredSizes: async (ids) => {
      passedIds = ids
      const map = {}
      for (const id of ids) map[id] = 100
      return map
    }
  }
  const input = Array.from({ length: 70 }, (_, i) => `sz_${i + 1}`).join(',')
  const res = await handleSizesRoute(store, input)
  assert.equal(res.status, 200)
  assert.equal(passedIds.length, SIZE_BATCH)
  assert.equal(Object.keys(res.body.sizes).length, SIZE_BATCH)
})

test('batch operations handle partial unreadable and missing sessions gracefully', async () => {
  const store = {
    open: async (id) => {
      if (id === 'missing') {
        const err = new Error('not found')
        err.code = 'ENOENT'
        throw err
      }
      if (id === 'broken') {
        return {
          read: async () => {
            throw new Error('corrupted JSON log')
          },
          close: async () => {}
        }
      }
      return {
        read: async () => ({
          events: [
            { type: 'user/message', time: 1, data: { message: { role: 'user', content: [{ type: 'text', text: `Valid ${id}` }] } } }
          ]
        }),
        close: async () => {}
      }
    }
  }

  // Titles should return valid titles and gracefully skip missing and broken
  const rTitles = await handleTitlesRoute(store, 'missing,valid_1,broken,valid_2')
  assert.equal(rTitles.status, 200)
  assert.equal(rTitles.body.titles['valid_1'], 'Valid valid_1')
  assert.equal(rTitles.body.titles['valid_2'], 'Valid valid_2')
  assert.equal(rTitles.body.titles['missing'], undefined)
  assert.equal(rTitles.body.titles['broken'], undefined)

  // Export should preserve session entries with correct status flags and valid markdown
  const rExport = await handleExportBatchRoute(store, 'missing,valid_1,broken')
  assert.equal(rExport.status, 200)
  assert.equal(rExport.body.sessions.length, 3)

  const sMissing = rExport.body.sessions.find((s) => s.id === 'missing')
  assert.equal(sMissing.missing, true)
  assert.equal(sMissing.unreadable, false)

  const sValid = rExport.body.sessions.find((s) => s.id === 'valid_1')
  assert.equal(sValid.missing, false)
  assert.equal(sValid.unreadable, false)
  assert.equal(sValid.messages.length, 1)

  const sBroken = rExport.body.sessions.find((s) => s.id === 'broken')
  assert.equal(sBroken.missing, false)
  assert.equal(sBroken.unreadable, true)

  assert.ok(rExport.body.markdown.includes('valid_1'), 'markdown should contain valid session')
})
