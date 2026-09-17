# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии — [SemVer](https://semver.org/lang/ru/).

## [Unreleased]

### Added

- Session size badges in the sidebar: yellow once a session is large, red once it is dangerous for the interface; event count shown as text, log size in the tooltip. Thresholds `sizeWarnEvents` / `sizeDangerEvents` in the settings card (#39).
- **Continue in new session**: opens a new chat in the same workspace with an instant extract of the previous session placed into the composer as a draft; nothing is sent (#40).
- **Continue with a model summary**: the same flow with a model-written summary; explicit click only, disabled until `handoffProvider` and `handoffModel` are set (#41).
- Routes `GET /dsh-session-control/sizes`, `GET /dsh-session-control/handoff`, `POST /dsh-session-control/handoff-summary`.

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
