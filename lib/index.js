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
import { transcriptFromEvents, parseTranscript } from './transcript.js'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

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



/**
 * Корневой каталог хранилища сессий.
 *
 * Сначала спрашиваем сам бэкенд: путь задаётся его конфигурацией и на разных
 * установках разный. Если он его не отдаёт, берём домашний каталог DSH из
 * окружения — переменную задаёт запускающая служба. Ничего не зашиваем.
 *
 * @param store - бэкенд хранения сессий.
 * @returns путь к каталогу сессий, или undefined, если определить нечем.
 */
function sessionsRoot(store) {
  const configured = store && store.config && store.config.root
  if (typeof configured === 'string' && configured !== '') return configured
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, 'sessions')
  return join(homedir(), '.dsh', 'sessions')
}

/**
 * Прочитать лог сессии в обход штатного пути.
 *
 * Нужен для старых сессий: ядро хранит их в формате v0 и отказывается
 * мигрировать при чтении, а именно они и лежат в архиве. Читаем только —
 * ничего не пишем и не переписываем.
 *
 * Корень берём у самого бэкенда (`config.root`), а не выдумываем: путь к
 * хранилищу задаётся конфигурацией и на разных установках разный.
 *
 * @param root - корневой каталог хранилища сессий.
 * @param sessionId - идентификатор сессии.
 * @returns текст лога, или undefined, если артефакт не найден.
 */
async function readStoredLogText(root, sessionId) {
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (noRoot) {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = join(root, project.name, sessionId)
    let files
    try {
      files = await readdir(dir)
    } catch (noSession) {
      continue
    }
    const compressed = files.find((name) => name.endsWith('.jsonl.zstd'))
    if (compressed !== undefined) {
      return zstdDecompressSync(await readFile(join(dir, compressed))).toString('utf8')
    }
    const plain = files.find((name) => name.endsWith('.jsonl'))
    if (plain !== undefined) return await readFile(join(dir, plain), 'utf8')
  }
  return undefined
}

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
          // Сначала штатный путь. Он отказывает на старых логах: ядровый
          // мигратор формата v0 отклоняет часть записей, а в архиве лежат
          // именно старые сессии — то есть ровно те, ради которых всё и
          // затевалось. Поэтому при отказе читаем сохранённый лог сами.
          let messages
          try {
            const path = await store.resolveLog(sessionId)
            if (path === undefined) {
              reply(404, { ok: false, error: 'session not found' })
              return
            }
            const log = await store.readStoredLog(path, sessionId)
            messages = transcriptFromEvents((log && log.events) || [])
            // Пустой результат на непустом файле — тоже повод пойти запасным
            // путём: на старых логах штатное чтение возвращает пустой лог, не
            // сообщая об отказе, и разговор пропадает молча.
            if (messages.length === 0) throw new Error('stored log came back empty')
          } catch (notMigratable) {
            const text = await readStoredLogText(sessionsRoot(store), sessionId)
            if (text === undefined) {
              // Отличаем «нет такой сессии» от «штатное чтение отказало»:
              // во втором случае молчать нельзя.
              if (String(notMigratable.message) === 'stored log came back empty') {
                reply(200, { ok: true, sessionId, total: 0, truncated: false, messages: [] })
                return
              }
              reply(404, { ok: false, error: 'session not found' })
              return
            }
            messages = parseTranscript(text)
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
