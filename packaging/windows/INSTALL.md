# Установка Windows-агента Dauys (Windows 11 x64)

## Для обычного пользователя (рекомендуется)

1. Скачайте **`DauysSetup-x64.exe`** (один установочный файл).
2. Запустите двойным кликом (права администратора не нужны).
3. Пройдите мастер: сервер → код привязки на телефоне → папки → приложения.
4. Агент работает в системном трее (без окна консоли).

Каталог: `%LOCALAPPDATA%\DauysAgent`  
Удаление: «Параметры → Приложения» (можно сохранить или стереть настройки).

Сборка установщика (на Windows-машине разработчика):

```powershell
pnpm install
pnpm build:agent:windows-installer
# → dist\windows-installer\DauysSetup-x64.exe
```

Нужны Node 24+, pnpm 11 и [Inno Setup 6](https://jrsoftware.org/isdl.php).  
Подпись: `packaging/windows/SIGNING.md`.

Перед заменой `bin\dauys-agent.exe` установщик сам останавливает агент/tray
текущего пользователя и чинит ACL только у `bin` и `helpers` (без прав администратора).
Token / trust / ledger не ослабляются.

---

## Для разработчиков

Агент — пользовательская сессия (Startup / VBS без консоли), не служба Windows.

**Полная инструкция для архива переноса:** `BUILD-ON-WINDOWS.md`

### Вариант A — графический установщик

`pnpm build:agent:windows-installer` → `DauysSetup-x64.exe`

### Вариант B — SEA + install.ps1

```powershell
pnpm build:agent:windows
cd dist\windows
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

### Вариант C — из исходников

```powershell
pnpm install
copy .env.windows-work.example .env
pnpm dev:agent
```

## Доверие к приложениям

Пути к `.exe` хранятся **только локально** (`agent-apps.json`).  
Сервер и телефон получают лишь `applicationId`, имя и aliases — не путь.

## Этапы

1. Сборка установщика на Windows 11 x64  
2. Проверка на VM без Node.js  
3. Привязка к https://dauys.esl.kz  
