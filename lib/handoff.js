/**
 * Handoff text for "continue in a new session".
 *
 * Two variants share this module: an instant extract assembled without a
 * model, and the prompt plus draft wrapper for a model-written summary. The
 * resulting text is placed into the new session's composer as a draft and is
 * never sent on the person's behalf.
 *
 * Pure and dependency-free: the model call itself lives in the server half and
 * is injected, so everything here is testable without the harness or network.
 */

/** Default character budget of the instant extract. */
export const EXTRACT_MAX_CHARS = 6000

/** How many recent human requests the extract keeps. */
const RECENT_REQUESTS = 3

/** Per-request cap inside the extract. */
const REQUEST_CHARS = 600

/** Cap of the last agent report inside the extract. */
const REPORT_CHARS = 3500

/** Default character budget of the transcript tail handed to the model. */
export const SUMMARY_MAX_INPUT_CHARS = 60000

/**
 * Whether a user-role message was written by the person.
 *
 * The harness also stores injected context as user messages: workspace
 * instructions, skill lists, memory snapshots and runtime snapshots. They are
 * large and say nothing about what the person asked for.
 * @param text - message text.
 * @returns true for a genuine human request.
 */
export function isHumanRequest(text) {
  const s = String(text || '').trim()
  if (s === '') return false
  if (s.startsWith('<')) return false
  if (/^Current runtime context\b/.test(s)) return false
  return true
}

/**
 * Collapse whitespace and cut a text to a length, marking the cut.
 * @param text - source text.
 * @param max - maximum length.
 * @returns the shortened text.
 */
export function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

/**
 * Keep line breaks but cut a long block, marking the cut.
 * @param text - source text.
 * @param max - maximum length.
 * @returns the shortened block.
 */
function clipBlock(text, max) {
  const s = String(text || '').trim()
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

/**
 * Header lines naming the previous session.
 * @param meta - `{ title, sessionId, cwd }`.
 * @returns lines of text.
 */
function headerLines(meta) {
  const lines = []
  const title = clip(meta.title || '', 160)
  lines.push('Previous session: ' + (title ? title + ' (' + meta.sessionId + ')' : meta.sessionId))
  if (meta.cwd) lines.push('Workspace: ' + meta.cwd)
  return lines
}

/**
 * Build the instant extract, assembled without a model.
 * @param input - `{ title, sessionId, cwd, messages, unreadable, maxChars }`,
 *   where messages are `{ role, text }` in log order.
 * @returns the draft text.
 */
export function buildHandoffExtract(input) {
  const max = Number(input.maxChars) > 0 ? Number(input.maxChars) : EXTRACT_MAX_CHARS
  const out = [
    'Continuing from a previous session that grew too large for the interface.',
    '',
    ...headerLines(input),
  ]

  if (input.unreadable) {
    out.push('', 'The previous conversation could not be read, so only its name and workspace are known.')
    return clipBlock(out.join('\n'), max)
  }

  const messages = Array.isArray(input.messages) ? input.messages : []
  const requests = messages
    .filter((m) => m && m.role === 'user' && isHumanRequest(m.text))
    .slice(-RECENT_REQUESTS)
    .map((m) => clip(m.text, REQUEST_CHARS))
  const reports = messages.filter((m) => m && m.role === 'assistant' && String(m.text || '').trim() !== '')
  const lastReport = reports.length ? clipBlock(reports[reports.length - 1].text, REPORT_CHARS) : ''

  if (requests.length) {
    out.push('', 'Recent requests:')
    requests.forEach((r, i) => out.push(i + 1 + '. ' + r))
  }
  if (lastReport) {
    out.push('', 'Last agent report:', lastReport)
  }
  if (!requests.length && !lastReport) {
    out.push('', 'The previous session has no conversation to carry over.')
  }
  out.push('', 'Please pick up from here.')
  return clipBlock(out.join('\n'), max)
}

/** System instruction for the model-written summary. */
export const SUMMARY_SYSTEM = [
  'You write handoff summaries so a coding agent can continue work in a fresh session.',
  'Summarize the conversation transcript you are given. Be concrete and brief.',
  'Use exactly these sections, each with short bullet points:',
  'Goal; Done so far; Still open; Agreements and constraints; Key files, commands and references.',
  'Keep names of files, projects, issues, commands and decisions exactly as written.',
  'Do not invent anything that is not in the transcript. Write in the language the person used.',
].join(' ')

/**
 * Render transcript messages into plain lines for the model.
 * @param messages - `{ role, text }` in log order.
 * @returns lines, oldest first.
 */
function transcriptLines(messages) {
  const lines = []
  for (const m of messages) {
    if (!m) continue
    if (m.role === 'user') {
      if (!isHumanRequest(m.text)) continue
      lines.push('PERSON: ' + String(m.text).trim())
    } else if (m.role === 'assistant') {
      const text = String(m.text || '').trim()
      if (text) lines.push('AGENT: ' + text)
    } else if (m.role === 'tool') {
      lines.push('[tool: ' + m.text + ']')
    }
  }
  return lines
}

/**
 * Build the model input from the tail of the transcript within a budget.
 *
 * A huge session cannot be handed to the model whole; the newest part matters
 * most for continuing, so lines are taken from the end until the budget runs out.
 * @param input - `{ title, sessionId, cwd, messages, maxInputChars }`.
 * @returns `{ system, text, truncated }`.
 */
export function buildSummaryRequest(input) {
  const budget = Number(input.maxInputChars) > 0 ? Number(input.maxInputChars) : SUMMARY_MAX_INPUT_CHARS
  const lines = transcriptLines(Array.isArray(input.messages) ? input.messages : [])
  const kept = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1
    if (used + cost > budget) break
    kept.push(lines[i])
    used += cost
  }
  kept.reverse()
  const truncated = kept.length < lines.length
  const text = [
    ...headerLines(input),
    truncated ? 'Only the most recent part of a longer conversation is included.' : 'The whole conversation is included.',
    '',
    'Transcript:',
    kept.join('\n'),
  ].join('\n')
  return { system: SUMMARY_SYSTEM, text, truncated }
}

/**
 * Wrap a model summary into the draft placed into the new session.
 * @param input - `{ title, sessionId, cwd, summary, truncated }`.
 * @returns the draft text.
 */
export function buildSummaryDraft(input) {
  const summary = String(input.summary || '').trim()
  const out = [
    'Continuing from a previous session that grew too large for the interface.',
    '',
    ...headerLines(input),
    '',
    input.truncated
      ? 'Summary of the most recent part of that session (written by a model):'
      : 'Summary of that session (written by a model):',
    summary,
    '',
    'Please pick up from here.',
  ]
  return out.join('\n')
}

/**
 * Join the text blocks of an assembled model answer.
 * @param blocks - assembled content blocks.
 * @returns the text, trimmed.
 * @throws when the model answered with tool calls or with no text.
 */
export function summaryTextFromBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  if (list.some((b) => b && b.type === 'tool-call')) throw new Error('model answered with a tool call instead of text')
  const text = list.filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim()
  if (text === '') throw new Error('model produced no text')
  return text
}
