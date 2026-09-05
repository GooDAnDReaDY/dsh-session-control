/**
 * Серверная половина dsh-session-control.
 *
 * Здесь живут пространство настроек (закрепления и скрытия) и один маршрут —
 * расшифровка заархивированной сессии.
 *
 * Почему маршрут вообще понадобился. Заархивированную сессию нельзя открыть в
 * браузере: окно истории у клиента поднимается только для сессии «на сцене»,
 * то есть текущей, а текущей архивная быть не может — политика ядра снимает
 * такой выбор. Потоковый `session/follow` по обычному запросу не открывается,
 * ему нужен потоковый переносчик, а `session/page` отвечает «failed to observe
 * session», пока за сессией не следят.
 *
 * Зато на хосте есть штатная дверь: `sessionPersistence.readRaw(id)` отдаёт
 * сохранённый лог, не поднимая живую сессию. Через неё мы и читаем.
 */
import z from '@deepseek-ai/schemastery'
import { transcriptFromEvents } from './transcript.js'

export const name = 'dsh-session-control'

/** Пространство настроек. Совпадает с ключом карточки settings.plugin.item. */
export const NS = 'dsh-session-control'

/** Сколько сообщений отдаём за один запрос: расшифровка читается, а не листается бесконечно. */
const TRANSCRIPT_LIMIT = 400

export const Config = z.object({
  /**
   * Идентификаторы закреплённых сессий. Порядок массива — порядок в панели.
   * Закрепление общее на всю панель, а не внутри папки.
   */
  pinned: z.array(z.string()).default([]),
  /**
   * Идентификаторы скрытых сессий. Наше скрытие обратимо, в отличие от
   * ядрового архива: WorkspaceRegistry.archiveSession только добавляет, метода
   * возврата в API нет.
   */
  hidden: z.array(z.string()).default([]),
})



export function apply(ctx, config) {
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(NS, Config, { base: config })
  })

  ctx.inject(['webServer', 'sessionPersistence'], (rctx) => {
    rctx.effect(() => rctx.webServer.register({
      kind: 'exact',
      path: '/dsh-session-control/transcript',
      handler: async (req, res) => {
        const reply = (code, body) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        }
        try {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = url.searchParams.get('session')
          if (sessionId === null || sessionId === '') {
            reply(400, { ok: false, error: 'session parameter is required' })
            return
          }
          // Сервис берём через get, а не как свойство контекста: так делает и
          // ядровый экспорт логов.
          const store = rctx.get('sessionPersistence')
          // Поверхность бэкенда различается между выпусками ядра: где-то есть
          // readRaw, где-то пара resolveLog + readStoredLog. Спрашиваем, что
          // умеет этот, вместо того чтобы полагаться на версию.
          if (store === undefined
              || typeof store.resolveLog !== 'function'
              || typeof store.readStoredLog !== 'function') {
            reply(501, { ok: false, error: 'this session backend cannot read stored logs' })
            return
          }
          // Старые логи формата v0 ядро отказывается мигрировать при чтении
          // и возвращает пустой лог, не сообщая об отказе. Отличаем это от
          // действительно пустой сессии: врать «сообщений нет» нельзя.
          let messages = []
          let unreadable = false
          let missing = false
          try {
            // resolveLog сам запускает миграцию формата и бросает на старых
            // логах, поэтому под перехватом должен быть и он, а не только
            // чтение.
            const path = await store.resolveLog(sessionId)
            if (path === undefined) {
              missing = true
            } else {
              const log = await store.readStoredLog(path, sessionId)
              const events = (log && log.events) || []
              messages = transcriptFromEvents(events)
              unreadable = events.length === 0
            }
          } catch (refused) {
            unreadable = true
          }
          if (missing) {
            reply(404, { ok: false, error: 'session not found' })
            return
          }
          if (unreadable) {
            reply(200, { ok: true, sessionId, unreadable: true, total: 0, truncated: false, messages: [] })
            return
          }
          reply(200, {
            ok: true,
            sessionId,
            total: messages.length,
            truncated: messages.length > TRANSCRIPT_LIMIT,
            messages: messages.slice(-TRANSCRIPT_LIMIT),
          })
        } catch (failure) {
          reply(500, { ok: false, error: (failure && failure.message) || String(failure) })
        }
      },
    }), 'dsh-session-control: маршрут расшифровки')
  })
}
