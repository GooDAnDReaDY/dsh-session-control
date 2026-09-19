# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии — [SemVer](https://semver.org/lang/ru/).

## [0.2.3] — 2026-09-19

### Исправлено
- **Настройки снова видны на странице плагина**: ядро 0.1.6-alpha.2 рендерит страницу настроек плагина только для записей в списочном слоте `plugins.item` — именно так показывают свои настройки `dsh-agentrouter` и `dsh-agent-orchestrator`. Карточка зарегистрирована и там (`id: 'dsh-session-control'`, order 60, **статичный** label — без обращений к локали, потому что это роняет весь клиентский батч); посадки `plugins.row.config` и `settings.plugin.item` сохранены как фолбэки.

## [0.2.2] — 2026-09-19

### Fixed
- **Настройки снова доступны.** Карточка регистрировалась в `settings.plugin.item` —
  слот, который текущее ядро DSH (0.1.6-alpha.2) **не рендерит**, поэтому настройки
  были недостижимы. Теперь поверхность регистрируется первой в посадке строки на
  странице «Плагины» — `plugins.row.config` с ключом
  `@goodandready/dsh-session-control#dsh-session-control`: у строки плагина
  появляется контрол «настроить», чья страница — форма настроек (`view: 'page'`,
  раскрытая и без нашей карточки и шапки), плюс однострочник для
  `view: 'summary'`. Прежняя посадка `settings.plugin.item` сохранена фолбэком.

## [0.2.1] — 2026-09-18

### Security

- Enforced strict fail-closed source verification on transcript, title, batch, and size routes via `isTrustedOrigin` and `guardRoute` (#33).
- Restricted HTTP methods with 405 Method Not Allowed responses, rejected non-loopback untrusted requests with 403 Forbidden (#33).

### Fixed

- Port session navigation, retention, clearing, and restoration to DSH alpha2 (`0.1.6-alpha.2`) Client Session API contract (#46).
- Replaced stale `sessions.open(id)` and `sessions.clear()` calls with `uiWorkspace.openSession(id)` and session retention under `{ source: 'mainView' }` (#46).
- Added `dsh.sessions.current` snapshot store integration for robust session restoration across page reloads (#46).
- Fixed active session row indicator in `SessionListPanel` to observe session retention leases (`retainedBy.mainView`) (#46).
- Injected `layout` service (`@deepseek-ai/dsh-client-ui-layout`) to properly handle workspace navigation abort signals (#46).

## [0.2.0] — 2026-09-17

### Added

- Session size badges in the sidebar: warning (yellow) and danger (red) indicators based on event counts, preventing client browser tab hangs on unvirtualized chat lists (#39).
- Configurable session size thresholds `sizeWarnEvents` (default 1500) and `sizeDangerEvents` (default 3000) in settings card (#39).
- Instant conversation handoff ("Continue in new session") via draft staging into `conversation.input.dock` (#40).
- Model-assisted handoff summary with configurable provider, model, token budget, and prompt (#41).
- Built-in one-click plugin updater from settings card via `/api/dsh-session-control/update` (#32).
- HTTP API endpoints: `GET /dsh-session-control/sizes`, `GET /dsh-session-control/handoff`, `POST /dsh-session-control/handoff-summary`, `POST /api/dsh-session-control/update`.
- Comprehensive test suite covering route limits, size calculations, handoff extracts, and plugin updater (55 tests, 100% pass) (#36).

### Changed

- Package identity aligned to fully qualified scoped name `@goodandready/dsh-session-control` across all manifests and exports (#31).
- Added fail-closed security guards (`guardRoute`) enforcing HTTP methods (405) and `sec-fetch-site` validation (403) across all HTTP endpoints (#33).
- Replaced hardcoded CSS colors with native theme variables and `color-mix` for seamless light/dark mode adaptation (#38).
- Translated all internal code comments to English and added regression test preventing Cyrillic characters in codebase (#34).
- Formalized single-bundle zero-build architecture decision for `lib/client.js` in design contract (#37).

## [0.1.4] — 2026-09-14

### Fixed

- Added required `data-dsh-plugin="dsh-session-control"` attribute on dynamic `<style>` tag to prevent style wipes by neighboring plugins during HMR / reloads per `dsh-plugin-authoring` (#29).
- Translated internal runtime `console.warn` / `console.error` messages and Cordis `ctx.effect` labels to canonical English (#29).

### Added

- Mermaid (`graph LR`) architecture flow diagram in `README.md`, `README.ru.md`, and `README.zh.md` (#29).
- Dedicated HTTP API Routes Reference section in all three README files (#29).
- Updated `docs/design/DESIGN.md` status, API surfaces, and locked design decisions (#29).

## [0.1.3] — 2026-09-13

### Fixed

- Adapted `readTranscript` and `canRead` to modern DSH core (0.1.5-rc.2+) descriptor-based
  `sessionPersistence.open` / `handle.read` API with proper resource cleanup, resolving HTTP 501
  failures on `/dsh-session-control/titles` and `/dsh-session-control/transcript` (#23).

### Added

- Category filter chips (All, Pinned, Tags, Archived) in the Alt+K quick jump palette (#24).
- Turns and activity count badges in session rows (#25).
- Clean session duplication (Fork Clean) preserving workspace settings without message history (#26).
- Bulk actions bar support for batch permanent archiving and batch Markdown export with table of contents (#27).
- Full Chinese (zh) localization dictionary registered alongside English (en).

## [0.1.2] — 2026-09-07

### Added

- Метки: своя ось группировки поверх рабочих папок. Ставятся из меню строки и
  групповым действием, фильтруют панель вместе с архивом, опустевшая метка
  удаляется сама. Новое поле настроек `labels`.
- Подпись диалога выводится из первой фразы человека, когда своего названия у
  сессии нет. Маршрут `GET /dsh-session-control/titles?sessions=<id,...>`.
  Ручное переименование всегда главнее выведенной подписи.
- Быстрый переход по `Alt+K`: поиск по названию и содержимому сразу, стрелки и
  Enter, архивный результат открывается расшифровкой.
- Выгрузка расшифровки в Markdown: копирование в буфер и сохранение файлом.
  Тот же маршрут расшифровки с `format=md`.

### Fixed

- Под поиском разделы «Скрытые» и «Архив» оставались свёрнутыми, и найденное в
  них не было видно.
- Снятие метки было неотличимо от её постановки: пункт меню показывал имя метки
  с малозаметной галочкой, и человек снятия не находил. Теперь пункт называет
  действие — «добавить в «имя»» или «убрать из «имя»» — и отделён разделителем.
  Под фильтром по метке появилось групповое снятие с выбранных строк.
- Окно быстрого перехода не открывалось: `Ctrl+K` браузер оставляет себе и
  странице не отдаёт. Сочетание заменено на `Alt+K`, кириллическая раскладка
  учтена.

## [0.1.0] — 2026-09-07

Первый выпуск.

### Added

- Список сессий в боковой панели взамен штатного блока рабочих папок: папки,
  сессии, поиск, свёртка, режим узкой панели, создание рабочей папки с выбором
  каталога.
- Закрепление диалогов, общее на всю панель; порядок задаётся вручную.
- Обратимое скрытие — в отличие от ядрового архива, который необратим.
- Раздел архива, которого в штатной панели нет вовсе, разбитый по периодам:
  сегодня, на этой неделе, в этом месяце, раньше. Свёрнутый период не рисуется.
- Расшифровка архивной сессии, только на чтение: маршрут
  `GET /dsh-session-control/transcript?session=<id>` и окно просмотра.
- Фрагмент с совпадением в результатах поиска по содержимому.
- Скрытие сессий без сообщений, кроме текущей; переключается в настройках.
- Множественный выбор строк с диапазоном по Shift и групповыми действиями.
- Переименование по двойному клику или F2 прямо в строке.
- Индикатор работающей сессии в строке.
- Карточка настроек в «Настройки → Плагины».

### Notes

- Плагин заменяет тело боковой панели и отдаёт вместо ядрового модуля служебный
  сервис `uiWorkspace`, от которого зависят модули панели и беседы. Половина
  «сервис» отделена от половины «интерфейс», чтобы отказ вёрстки не гасил
  приложение.
- Переноса диалога между рабочими папками нет и не будет: членство выводится из
  рабочего каталога сессии, а не хранится меткой.
- Возврата из архива нет: ядро умеет только помещать в архив.
- Часть архивных журналов раннего формата ядро читать отказывается; такие
  сессии показываются с пояснением, а не с ложным «нет сообщений».
- Интерфейс только на английском; переводы поставляет отдельный языковой
  плагин.
