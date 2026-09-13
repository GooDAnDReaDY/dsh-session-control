/**
 * Превращение лога сессии в расшифровку.
 *
 * Модуль намеренно без единой внешней зависимости: это чистая логика, и она
 * должна проверяться тестами без харнесса и без установки профиля.
 */

/**
 * Отобрать из событий то, что человек считает разговором.
 *
 * Берём его собственные сообщения, ответы агента и факт вызова инструмента.
 * Рассуждения модели пропускаем — это её черновик, а не содержание беседы.
 *
 * @param events - события лога в порядке записи.
 * @returns сообщения в том же порядке.
 */
export function transcriptFromEvents(events) {
  const out = []
  for (const event of events || []) {
    const kind = event && event.type
    if (kind === 'user/message' || kind === 'assistant/message') {
      // Две формы записи живут одновременно: у сообщения человека содержимое
      // лежит прямо в data.content, у ответа агента — в data.message.content.
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
 * То же самое, но из сырого текста лога — одна JSON-запись на строку.
 *
 * Битые строки пропускаем: одна повреждённая запись не должна лишать человека
 * всей остальной расшифровки.
 *
 * @param raw - содержимое файла лога.
 * @returns сообщения в порядке лога.
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

/** Предельная длина выведенной подписи. Дальше строка всё равно обрезается многоточием в разметке. */
const TITLE_LIMIT = 70

/**
 * Вывести подпись диалога из первого сообщения человека.
 *
 * Никакой модели: берём начало первой фразы как есть. Пересказ «по смыслу»
 * стоил бы денег и врал бы, а человеку нужно узнать свой разговор в списке.
 *
 * Переносы строк схлопываем: подпись рисуется одной строкой, и «шапка»
 * вставленного текста не должна съедать её целиком.
 *
 * @param messages - расшифровка сессии.
 * @returns подпись или пустая строка, если человек в этой сессии не писал.
 */
export function titleFromTranscript(messages) {
  const first = (messages || []).find((m) => m && m.role === 'user' && String(m.text).trim() !== '')
  if (first === undefined) return ''
  const flat = String(first.text).replace(/\s+/g, ' ').trim()
  if (flat.length <= TITLE_LIMIT) return flat
  // Режем по границе слова, чтобы подпись не обрывалась посреди слова.
  const cut = flat.slice(0, TITLE_LIMIT)
  const space = cut.lastIndexOf(' ')
  return (space > TITLE_LIMIT / 2 ? cut.slice(0, space) : cut) + '…'
}

/**
 * Собрать расшифровку в Markdown для переноса в заметку или задачу.
 *
 * Формат намеренно простой: содержимое должно читаться в любом редакторе, а
 * не подходить одному конкретному сервису.
 *
 * @param title - название диалога.
 * @param messages - показанные сообщения.
 * @param info - `total` всего сообщений и признак `truncated`.
 * @returns текст Markdown.
 */
export function transcriptToMarkdown(title, messages, info) {
  const meta = info || {}
  const lines = ['# ' + (String(title || '').trim() || 'Session transcript'), '']
  if (meta.truncated === true) {
    // Честно предупреждаем: иначе человек унесёт огрызок, считая его целым
    // разговором.
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
 * Собрать несколько расшифровок в один общий Markdown-документ.
 *
 * @param items - массив объектов { title, messages, info }.
 * @returns объединенный текст Markdown.
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
    // Убираем верхний заголовок # чтобы сохранить иерархию документа
    const body = single.replace(/^#\s+[^\n]*\n+/, '')
    lines.push(body, '', '---', '')
  })

  return lines.join('\n')
}
