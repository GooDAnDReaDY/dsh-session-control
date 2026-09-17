import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildHandoffExtract,
  buildSummaryRequest,
  buildSummaryDraft,
  summaryTextFromBlocks,
  isHumanRequest,
  clip,
} from '../lib/handoff.js'

const meta = { title: 'dsh-model-search review', sessionId: 'session-abc', cwd: '/work/project' }

test('injected context is not mistaken for a human request', () => {
  assert.equal(isHumanRequest('check the queue and update stats'), true)
  assert.equal(isHumanRequest('<system-reminder>instructions</system-reminder>'), false)
  assert.equal(isHumanRequest('<agentmemory_context agent_id="x">'), false)
  assert.equal(isHumanRequest('Current runtime context. This snapshot supersedes'), false)
  assert.equal(isHumanRequest('   '), false)
})

test('extract carries header, recent human requests and the last agent report', () => {
  const messages = [
    { role: 'user', text: 'first request' },
    { role: 'assistant', text: 'old report' },
    { role: 'user', text: '<system-reminder>noise</system-reminder>' },
    { role: 'user', text: 'second request' },
    { role: 'tool', text: 'bash' },
    { role: 'user', text: 'third request' },
    { role: 'user', text: 'fourth request' },
    { role: 'assistant', text: 'Queue of 19 checked, 26 verdicts published.' },
  ]
  const text = buildHandoffExtract({ ...meta, messages })
  assert.match(text, /Previous session: dsh-model-search review \(session-abc\)/)
  assert.match(text, /Workspace: \/work\/project/)
  assert.match(text, /1\. second request\n2\. third request\n3\. fourth request/)
  assert.doesNotMatch(text, /first request/)
  assert.doesNotMatch(text, /noise/)
  assert.match(text, /Last agent report:\nQueue of 19 checked, 26 verdicts published\./)
  assert.doesNotMatch(text, /old report/)
})

test('extract without any conversation says so', () => {
  const text = buildHandoffExtract({ ...meta, messages: [] })
  assert.match(text, /has no conversation to carry over/)
})

test('unreadable log keeps only name and workspace', () => {
  const text = buildHandoffExtract({ ...meta, messages: [], unreadable: true })
  assert.match(text, /could not be read/)
  assert.doesNotMatch(text, /Recent requests/)
})

test('extract stays within its character budget', () => {
  const huge = 'x'.repeat(50000)
  const text = buildHandoffExtract({ ...meta, maxChars: 2000, messages: [
    { role: 'user', text: huge }, { role: 'assistant', text: huge },
  ] })
  assert.ok(text.length <= 2000, String(text.length))
  assert.ok(text.endsWith('…'))
})

test('clip collapses whitespace and marks the cut', () => {
  assert.equal(clip('a  b\n\nc', 10), 'a b c')
  assert.equal(clip('abcdefghij', 5), 'abcd…')
})

test('summary request takes the newest part within the budget and says it is partial', () => {
  const messages = []
  for (let i = 0; i < 50; i++) messages.push({ role: 'user', text: 'request ' + i + ' ' + 'y'.repeat(80) })
  const req = buildSummaryRequest({ ...meta, messages, maxInputChars: 1000 })
  assert.equal(req.truncated, true)
  assert.match(req.text, /request 49/)
  assert.doesNotMatch(req.text, /request 0 /)
  assert.match(req.text, /Only the most recent part/)
  assert.match(req.system, /Goal; Done so far; Still open/)
})

test('summary request skips injected context and labels roles', () => {
  const req = buildSummaryRequest({ ...meta, messages: [
    { role: 'user', text: '<system-reminder>big</system-reminder>' },
    { role: 'user', text: 'do the thing' },
    { role: 'tool', text: 'write' },
    { role: 'assistant', text: 'done' },
  ] })
  assert.equal(req.truncated, false)
  assert.match(req.text, /PERSON: do the thing\n\[tool: write\]\nAGENT: done/)
  assert.doesNotMatch(req.text, /big/)
})

test('summary draft wraps the model text and marks partial input', () => {
  const draft = buildSummaryDraft({ ...meta, summary: 'Goal: ship it', truncated: true })
  assert.match(draft, /most recent part of that session \(written by a model\)/)
  assert.match(draft, /Goal: ship it/)
  assert.match(draft, /Please pick up from here\.$/)
})

test('model answer: text joined, tool calls and empty answers rejected', () => {
  assert.equal(summaryTextFromBlocks([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
  assert.throws(() => summaryTextFromBlocks([{ type: 'tool-call', name: 'x' }]), /tool call/)
  assert.throws(() => summaryTextFromBlocks([]), /no text/)
})
