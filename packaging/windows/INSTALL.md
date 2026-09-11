# Установка Windows-агента «Рядом» (Windows 11 x64)

Агент работает в пользовательской сессии (ярлык в Startup), не как служба Windows.

**Полная инструкция для архива переноса** (сборка → тестовый сервер → https://dauys.esl.kz):  
`packaging/windows/BUILD-ON-WINDOWS.md`

`localhost` на Windows — это сам Windows-компьютер, не удалённый сервер.

## Требования

- Windows 11 x64
- Node.js **24+** x64 и pnpm 11 (для SEA-сборки)
- Сервер/PWA, доступные с этого ПК (тестовый стенд или production — разными этапами)

## Вариант A — SEA (`dauys-agent.exe`)

Сборку выполняйте **только на Windows**.

```powershell
pnpm install
pnpm build:agent:windows
cd dist\windows
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Бинарник: `%LOCALAPPDATA%\DauysAgent\bin\dauys-agent.exe`.  
Данные: `%LOCALAPPDATA%\DauysAgent\`.  
Удаление: `uninstall.ps1` или `uninstall.ps1 -Purge`.

## Вариант B — из исходников (`pnpm dev:agent`)

```powershell
pnpm install
copy .env.windows-work.example .env
# тестовый SERVER_PUBLIC_URL и AGENT_BOOTSTRAP_SECRET
# ALLOWED_DIRECTORIES=C:/Users/YOU/Documents,...
copy config\registry.windows.example.json data-windows-work\registry.json
pnpm dev:agent
```

## Реестр

На Windows у приложений — полный путь к `.exe` (`config/registry.windows.example.json`).  
`run_shortcut` — только id из `agent-trust.json` + `processes`.

## Этапы (кратко)

1. **Сборка** — `pnpm build:agent:windows` (без production-секретов).
2. **Тест** — привязка к тестовому серверу, доступному с этого ПК.
3. **Production** — новая привязка к https://dauys.esl.kz (`--reset` / `-Purge` после теста).
