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
      // Две формы в одном логе: у сообщений пользователя содержимое лежит
      // прямо в data.content, у ответов агента — в data.message.content.
      // Читаем обе, иначе половина разговора пропадает молча.
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
