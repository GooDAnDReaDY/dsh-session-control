import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTranscript, transcriptFromEvents } from '../lib/transcript.js'

const line = (obj) => JSON.stringify(obj)

test('берёт сообщения пользователя и агента в порядке лога', () => {
  const raw = [
    line({ type: 'session', id: 'session-1', createdAt: 1 }),
    line({ type: 'user/message', time: 10, data: { message: { role: 'user', content: [{ type: 'text', text: 'привет' }] } } }),
    line({ type: 'assistant/message', time: 20, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'здравствуйте' }] } } }),
  ].join('\n')

  assert.deepEqual(parseTranscript(raw), [
    { role: 'user', text: 'привет', time: 10 },
    { role: 'assistant', text: 'здравствуйте', time: 20 },
  ])
})

test('рассуждения модели в расшифровку не попадают', () => {
  const raw = line({
    type: 'assistant/message',
    time: 5,
    data: { message: { role: 'assistant', content: [
      { type: 'reasoning', text: 'черновик рассуждения' },
      { type: 'text', text: 'ответ' },
    ] } },
  })

  assert.deepEqual(parseTranscript(raw), [{ role: 'assistant', text: 'ответ', time: 5 }])
})

test('сообщение без текстовых частей пропускается целиком', () => {
  const raw = line({
    type: 'assistant/message',
    time: 7,
    data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'только черновик' }] } },
  })

  assert.deepEqual(parseTranscript(raw), [])
})

test('вызов инструмента отмечается отдельной строкой', () => {
  const raw = [
    line({ type: 'tool/call', time: 30, data: { name: 'read_file' } }),
    line({ type: 'tool/call', time: 31, data: { call: { name: 'write_file' } } }),
    line({ type: 'tool/result', time: 32, data: { name: 'read_file' } }),
  ].join('\n')

  assert.deepEqual(parseTranscript(raw), [
    { role: 'tool', text: 'read_file', time: 30 },
    { role: 'tool', text: 'write_file', time: 31 },
  ])
})

test('битая строка не лишает расшифровки остального лога', () => {
  const raw = [
    line({ type: 'user/message', time: 1, data: { message: { content: [{ type: 'text', text: 'до' }] } } }),
    '{ это не json',
    line({ type: 'user/message', time: 2, data: { message: { content: [{ type: 'text', text: 'после' }] } } }),
  ].join('\n')

  assert.deepEqual(parseTranscript(raw).map((m) => m.text), ['до', 'после'])
})

test('пустой ввод и пустые строки не ломают разбор', () => {
  assert.deepEqual(parseTranscript(''), [])
  assert.deepEqual(parseTranscript('\n\n  \n'), [])
})

test('служебные события пропускаются', () => {
  const raw = [
    line({ type: 'permission/preset', time: 1, data: { preset: 'workspace-write' } }),
    line({ type: 'turn/start', time: 2, data: { turn: 1 } }),
    line({ type: 'assistant/chunk', time: 3, data: {} }),
  ].join('\n')

  assert.deepEqual(parseTranscript(raw), [])
})

test('разобранные события дают ту же расшифровку, что и сырой лог', () => {
  const events = [
    { type: 'user/message', time: 1, data: { message: { content: [{ type: 'text', text: 'вопрос' }] } } },
    { type: 'tool/call', time: 2, data: { name: 'grep' } },
    { type: 'assistant/message', time: 3, data: { message: { content: [{ type: 'text', text: 'ответ' }] } } },
  ]
  const raw = events.map((e) => JSON.stringify(e)).join('\n')
  assert.deepEqual(transcriptFromEvents(events), parseTranscript(raw))
  assert.deepEqual(transcriptFromEvents(events).map((m) => m.role), ['user', 'tool', 'assistant'])
})

test('пустой список событий и отсутствие входа не ломают разбор', () => {
  assert.deepEqual(transcriptFromEvents([]), [])
  assert.deepEqual(transcriptFromEvents(undefined), [])
})

test('сообщение пользователя читается и из data.content, и из data.message.content', () => {
  // Настоящие логи содержат обе формы: первая у пользователя, вторая у агента.
  const прямая = { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'прямо' }] } }
  const вложенная = { type: 'user/message', time: 2, data: { message: { content: [{ type: 'text', text: 'внутри' }] } } }
  assert.deepEqual(transcriptFromEvents([прямая, вложенная]).map((m) => m.text), ['прямо', 'внутри'])
})
