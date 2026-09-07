/**
 * Серверная половина dsh-session-control.
 *
 * Здесь живут пространство настроек (закрепления, скрытия, метки) и два
 * маршрута чтения: расшифровка заархивированной сессии и выведенные подписи
 * для строк без сохранённого названия.
 *
 * Почему маршруты вообще понадобились. Заархивированную сессию нельзя открыть
 * в браузере: окно истории у клиента поднимается только для сессии «на сцене»,
 * то есть текущей, а текущей архивная быть не может — политика ядра снимает
 * такой выбор. Потоковый `session/follow` по обычному запросу не открывается,
 * ему нужен потоковый переносчик, а `session/page` отвечает «failed to observe
 * session», пока за сессией не следят.
 *
 * Зато на хосте есть штатная дверь: сохранённый лог сессии читается, не
 * поднимая живую сессию. Через неё мы и читаем. Только читаем.
 */
import z from '@deepseek-ai/schemastery'
import { transcriptFromEvents, titleFromTranscript, transcriptToMarkdown } from './transcript.js'

export const name = 'dsh-session-control'

/** Пространство настроек. Совпадает с ключом карточки settings.plugin.item. */
export const NS = 'dsh-session-control'

/** Сколько сообщений отдаём за один запрос: расшифровка читается, а не листается бесконечно. */
const TRANSCRIPT_LIMIT = 400

/**
 * Сколько подписей выводим за один запрос.
 *
 * Каждая подпись — это распаковка одного сохранённого лога. Ограничение
 * защищает хост от того, чтобы развёрнутый архив на сотню строк превратился в
 * сотню распаковок одним залпом.
 */
const TITLE_BATCH = 60

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
  /**
   * Прятать сессии без единого сообщения. Их непрерывно плодят расписания,
   * мессенджер и доска, и в списке они мешают настоящим разговорам.
   * Текущая сессия не прячется никогда, даже пустая: иначе пропадёт строка,
   * в которую человек как раз собирается писать.
   */
  hideBlank: z.boolean().default(true),
  /**
   * Метки: имя метки — список идентификаторов сессий.
   *
   * Это наша замена переносу между папками. Перенести диалог в другую папку
   * нельзя: рабочая папка — каталог на хосте, членство выводится из рабочего
   * каталога сессии. Метка живёт только у нас и ничего не меняет в ядре.
   */
  labels: z.dict(z.array(z.string())).default({}),
})

/**
 * Прочитать сохранённый лог сессии.
 *
 * Отличаем три исхода, потому что врать человеку нельзя: сессии нет вовсе,
 * лог есть, но ядро отказывается его читать (старый формат v0), и обычный
 * успех.
 *
 * @param store - сервис хранения сессий хоста.
 * @param sessionId - идентификатор сессии.
 * @returns `{ missing, unreadable, messages }`.
 */
async function readTranscript(store, sessionId) {
  try {
    // resolveLog сам запускает миграцию формата и бросает на старых логах,
    // поэтому под перехватом должен быть и он, а не только чтение.
    const path = await store.resolveLog(sessionId)
    if (path === undefined) return { missing: true, unreadable: false, messages: [] }
    const log = await store.readStoredLog(path, sessionId)
    const events = (log && log.events) || []
    // Старые логи формата v0 ядро возвращает пустыми, не сообщая об отказе.
    // Пустой лог и отказ выглядят одинаково, и мы честно говорим «не читается»
    // вместо «сообщений нет».
    return { missing: false, unreadable: events.length === 0, messages: transcriptFromEvents(events) }
  } catch (refused) {
    return { missing: false, unreadable: true, messages: [] }
  }
}

/**
 * Умеет ли этот бэкенд отдавать сохранённые логи.
 *
 * Поверхность различается между выпусками ядра: где-то есть readRaw, где-то
 * пара resolveLog + readStoredLog. Спрашиваем, что умеет этот, вместо того
 * чтобы полагаться на номер версии.
 *
 * @param store - сервис хранения сессий хоста.
 * @returns true, если чтение доступно.
 */
function canRead(store) {
  return store !== undefined
    && typeof store.resolveLog === 'function'
    && typeof store.readStoredLog === 'function'
}

export function apply(ctx, config) {
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(NS, Config, { base: config })
  })

  ctx.inject(['webServer', 'sessionPersistence'], (rctx) => {
    /**
     * Выведенные подписи живут в памяти процесса.
     *
     * Первое сообщение сессии не меняется никогда, поэтому пересчитывать его
     * не нужно ни разу за время работы хоста.
     */
    const titleCache = new Map()

    const json = (res, code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }

    rctx.effect(() => rctx.webServer.register({
      kind: 'exact',
      path: '/dsh-session-control/transcript',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = url.searchParams.get('session')
          if (sessionId === null || sessionId === '') {
            json(res, 400, { ok: false, error: 'session parameter is required' })
            return
          }
          // Сервис берём через get, а не как свойство контекста: так делает и
          // ядровый экспорт логов.
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
          const truncated = read.messages.length > TRANSCRIPT_LIMIT
          const shown = read.messages.slice(-TRANSCRIPT_LIMIT)
          // Выгрузка собирается здесь же, а не в браузере: логика сборки
          // Markdown одна на всех и покрыта тестами.
          if (url.searchParams.get('format') === 'md') {
            const title = url.searchParams.get('title') || sessionId
            const text = read.unreadable
              ? '# ' + title + '\n\n> The core declines to read this log format.\n'
              : transcriptToMarkdown(title, shown, { truncated, total: read.messages.length })
            res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
            res.end(text)
            return
          }
          if (read.unreadable) {
            json(res, 200, { ok: true, sessionId, unreadable: true, total: 0, truncated: false, messages: [] })
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
          json(res, 500, { ok: false, error: (failure && failure.message) || String(failure) })
        }
      },
    }), 'dsh-session-control: маршрут расшифровки')

    rctx.effect(() => rctx.webServer.register({
      kind: 'exact',
      path: '/dsh-session-control/titles',
      handler: async (req, res) => {
        try {
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
            json(res, 501, { ok: false, error: 'this session backend cannot read stored logs' })
            return
          }
          const titles = {}
          for (const sessionId of ids) {
            if (titleCache.has(sessionId)) {
              titles[sessionId] = titleCache.get(sessionId)
              continue
            }
            const read = await readTranscript(store, sessionId)
            // Нечитаемый или отсутствующий лог даёт пустую подпись, и она тоже
            // запоминается: повторно распаковывать безнадёжный лог незачем.
            const title = read.missing || read.unreadable ? '' : titleFromTranscript(read.messages)
            titleCache.set(sessionId, title)
            titles[sessionId] = title
          }
          json(res, 200, { ok: true, titles })
        } catch (failure) {
          json(res, 500, { ok: false, error: (failure && failure.message) || String(failure) })
        }
      },
    }), 'dsh-session-control: маршрут выведенных подписей')
  })
}
