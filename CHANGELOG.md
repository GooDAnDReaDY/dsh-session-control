# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии — [SemVer](https://semver.org/lang/ru/).

## [Unreleased]

### Added

- Каркас плагина: манифест, слой `cordis.patch.yml`, серверная половина с
  пространством настроек `dsh-session-control` (поля `pinned` и `hidden`).
- Браузерная половина «сервис»: сервис `uiWorkspace` взамен выключенного
  ядрового ряда `ui-workspace` и корневой хук списка папок.

### Notes

- Половина «интерфейс» ещё не реализована: тело боковой панели после установки
  пустое. Это ожидаемое состояние промежуточного шага.
