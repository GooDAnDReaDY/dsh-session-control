import test from 'node:test'
import assert from 'node:assert/strict'
import { titleFromTranscript, transcriptToMarkdown } from '../lib/transcript.js'

test('подпись берётся из первой фразы человека, а не из ответа агента', () => {
  const messages = [
    { role: 'assistant', text: 'приветствие от агента', time: 1 },
    { role: 'user', text: 'почини поиск в панели', time: 2 },
    { role: 'user', text: 'и ещё вот это', time: 3 },
  ]
  assert.equal(titleFromTranscript(messages), 'почини поиск в панели')
})

test('переносы строк схлопываются: подпись рисуется одной строкой', () => {
  const messages = [{ role: 'user', text: '  первая строка\n\nвторая  строка ', time: 1 }]
  assert.equal(titleFromTranscript(messages), 'первая строка вторая строка')
})

test('длинная фраза режется по границе слова и получает многоточие', () => {
  const long = 'слово '.repeat(40).trim()
  const title = titleFromTranscript([{ role: 'user', text: long, time: 1 }])
  assert.ok(title.length <= 71, title.length)
  assert.ok(title.endsWith('…'))
  assert.ok(!title.includes('  '))
})

test('без сообщений человека подписи нет', () => {
  assert.equal(titleFromTranscript([]), '')
  assert.equal(titleFromTranscript(undefined), '')
  assert.equal(titleFromTranscript([{ role: 'assistant', text: 'только агент', time: 1 }]), '')
  assert.equal(titleFromTranscript([{ role: 'user', text: '   ', time: 1 }]), '')
})

test('выгрузка складывает роли и текст в читаемый Markdown', () => {
  const md = transcriptToMarkdown('Разбор панели', [
    { role: 'user', text: 'вопрос', time: 1 },
    { role: 'tool', text: 'grep', time: 2 },
    { role: 'assistant', text: 'ответ', time: 3 },
  ], { truncated: false, total: 3 })

  assert.ok(md.startsWith('# Разбор панели\n'))
  assert.ok(md.includes('## You\n\nвопрос'))
  assert.ok(md.includes('## Agent\n\nответ'))
  assert.ok(md.includes('- tool: `grep`'))
  assert.ok(!md.includes('Showing the last'))
})

test('урезанная выгрузка честно об этом сообщает', () => {
  const md = transcriptToMarkdown('Длинный разговор',
    [{ role: 'user', text: 'хвост', time: 1 }], { truncated: true, total: 900 })
  assert.ok(md.includes('> Showing the last 1 of 900 messages.'))
})

test('выгрузка без названия и без сообщений не разваливается', () => {
  assert.equal(transcriptToMarkdown('', [], undefined), '# Session transcript\n')
})
