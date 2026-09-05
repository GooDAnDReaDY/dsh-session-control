/**
 * Серверная половина dsh-session-control.
 *
 * Плагин не добавляет своих HTTP-маршрутов и не имеет собственного хранилища:
 * все изменения браузерная половина делает через ядровые session/* и
 * workspace/*. Здесь объявляется только пространство настроек, в котором живут
 * закрепления и скрытия, — они обязаны переживать перезагрузку, смену браузера
 * и устройство, поэтому хранятся на хосте, а не в браузере.
 */
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-session-control'

/** Пространство настроек. Совпадает с ключом карточки settings.plugin.item. */
export const NS = 'dsh-session-control'

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
}
