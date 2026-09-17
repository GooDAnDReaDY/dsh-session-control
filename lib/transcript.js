/**
 * Convert session log events into a readable transcript.
 *
 * This module has zero external dependencies: pure logic that
 * must be testable without the harness and without profile installation.
 */

/**
 * Filter log events into what a human considers conversation messages.
 *
 * Extracts human prompts, agent responses, and tool call invocations.
 * Model reasoning thoughts are skipped — they represent intermediate drafts,
 * not dialogue content.
 *
 * @param events - Log events in recorded order.
 * @returns Messages in the same chronological order.
 */
export function transcriptFromEvents(events) {
  const out = []
  for (const event of events || []) {
    const kind = event && event.type
    if (kind === 'user/message' || kind === 'assistant/message') {
      // Both record formats exist concurrently: human message content is in
      // data.content, while agent responses place it in data.message.content.
      const data = event.data || {}
      const message = data.message || {}
      const parts = Array.isArray(data.content)
        ? data.content
        : (Array.isArray(message.content) ? message.content : [])
      const text = parts
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
      if (text.trim() === '') continue
      out.push({ role: kind === 'user/message' ? 'user' : 'assistant', text, time: event.time })
    } else if (kind === 'tool/call') {
      const data = event.data || {}
      const toolName = data.name || (data.call && data.call.name)
      if (typeof toolName === 'string' && toolName !== '') {
        out.push({ role: 'tool', text: toolName, time: event.time })
      }
    }
  }
  return out
}

/**
 * Parse messages from raw JSONL log text — one JSON record per line.
 *
 * Corrupted lines are safely skipped: a single damaged record must not deprive
 * the user of the remaining transcript.
 *
 * @param raw - Raw log file content.
 * @returns Messages in log order.
 */
export function parseTranscript(raw) {
  const events = []
  for (const line of String(raw).split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch (notJson) {
      continue
    }
  }
  return transcriptFromEvents(events)
}

/** Maximum length of an inferred title. Beyond this, layout clips with ellipsis. */
const TITLE_LIMIT = 70

/**
 * Infer conversation title from the first human message.
 *
 * No model needed: extract the beginning of the first human message verbatim.
 * Semantic summarization costs tokens and hallucinates; users need to recognize
 * their conversation in the sidebar list.
 *
 * Newlines are collapsed into a single line so pasted multi-line headers
 * do not consume the entire title preview.
 *
 * @param messages - Session transcript.
 * @returns Inferred title, or empty string if user never spoke.
 */
export function titleFromTranscript(messages) {
  const first = (messages || []).find((m) => m && m.role === 'user' && String(m.text).trim() !== '')
  if (first === undefined) return ''
  const flat = String(first.text).replace(/\s+/g, ' ').trim()
  if (flat.length <= TITLE_LIMIT) return flat
  // Clip on a word boundary so titles do not break mid-word.
  const cut = flat.slice(0, TITLE_LIMIT)
  const space = cut.lastIndexOf(' ')
  return (space > TITLE_LIMIT / 2 ? cut.slice(0, space) : cut) + '…'
}

/**
 * Assemble session transcript into Markdown for copying into notes or issues.
 *
 * Format is intentionally plain and readable in any standard markdown viewer.
 *
 * @param title - Conversation title.
 * @param messages - Displayed messages.
 * @param info - Total message count and truncated flag.
 * @returns Markdown text.
 */
export function transcriptToMarkdown(title, messages, info) {
  const meta = info || {}
  const lines = ['# ' + (String(title || '').trim() || 'Session transcript'), '']
  if (meta.truncated === true) {
    // Explicitly warn if truncated so fragments are not mistaken for full logs.
    lines.push('> Showing the last ' + (messages || []).length + ' of ' + (meta.total || 0)
      + ' messages.', '')
  }
  for (const message of messages || []) {
    if (message.role === 'tool') {
      lines.push('- tool: `' + message.text + '`', '')
      continue
    }
    lines.push('## ' + (message.role === 'user' ? 'You' : 'Agent'), '', String(message.text), '')
  }
  return lines.join('\n')
}

/**
 * Assemble multiple session transcripts into a single combined Markdown document.
 *
 * @param items - Array of { title, messages, info } objects.
 * @returns Combined Markdown text with Table of Contents.
 */
export function batchTranscriptToMarkdown(items) {
  const list = Array.isArray(items) ? items : []
  const lines = [
    '# Combined Session Export',
    '',
    '> Exported ' + list.length + ' session(s).',
    '',
    '## Table of Contents',
    '',
  ]

  list.forEach((item, index) => {
    const title = String(item.title || ('Session ' + (index + 1))).trim()
    lines.push((index + 1) + '. ' + title)
  })
  lines.push('', '---', '')

  list.forEach((item, index) => {
    const title = String(item.title || ('Session ' + (index + 1))).trim()
    lines.push('## ' + (index + 1) + '. ' + title, '')
    const single = transcriptToMarkdown(title, item.messages, item.info)
    // Demote top heading # to preserve document hierarchy.
    const body = single.replace(/^#\s+[^\n]*\n+/, '')
    lines.push(body, '', '---', '')
  })

  return lines.join('\n')
}
