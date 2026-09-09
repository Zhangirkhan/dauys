# Сборка и запуск Windows-агента на Windows 11 x64

Этот архив — исходники для переноса. **Не содержит** production `.env`, токены, БД, логи, `.git`, `node_modules`.

`localhost` / `127.0.0.1` на Windows — это **сам Windows-ПК**, не Linux-сервер и не телефон. Сервер и PWA на другом хосте указывайте по IP/DNS и HTTPS.

---

## 0. Требования на Windows-ПК

- Windows 11 x64
- [Node.js 24+ x64](https://nodejs.org/) (нужен для SEA: бинарник агента = Node + blob)
- pnpm 11: `corepack enable` затем `corepack prepare pnpm@11.9.0 --activate`
- [Inno Setup 6](https://jrsoftware.org/isdl.php) — только для `pnpm build:agent:windows-installer`
- Распакуйте архив в каталог без кириллицы в пути по возможности, например `C:\src\dauys-agent`

```powershell
cd C:\src\dauys-agent   # ваш путь к распакованному архиву
pnpm install
```

Дальше — три отдельных этапа.

---

## 1. Сборка агента и установщика (без привязки к серверу)

```powershell
pnpm build:agent:windows
```

Ожидаемый результат: `dist\windows\dauys-agent.exe`, рядом `install.ps1`, `uninstall.ps1`, `INSTALL.md`.

**Установщик для пользователей** (один `.exe`, без Node на целевом ПК):

```powershell
pnpm build:agent:windows-installer
# → dist\windows-installer\DauysSetup-x64.exe
```

Альтернатива для разработчиков:

```powershell
cd dist\windows
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

После установки: `%LOCALAPPDATA%\DauysAgent\bin\dauys-agent.exe`.  
Данные: `%LOCALAPPDATA%\DauysAgent\` (токен, `agent-apps.json`).  
Автозапуск: VBS без консоли + значок в трее.

Пока **не** вводите bootstrap-секрет production:

```powershell
Get-Process dauys-agent -ErrorAction SilentlyContinue | Stop-Process
```

---

## 2. Проверка на тестовом сервере

Тестовый сервер и PWA должны быть **доступны с Windows-ПК** (не путайте с `localhost` Linux-машины).

### Если сервер крутится на этом же Windows-ПК

В `.env` агента / переменных окружения:

- `SERVER_PUBLIC_URL=http://127.0.0.1:8787`
- PWA: `http://127.0.0.1:5173` (или ваш порт)
- Скопируйте `.env.windows-work.example` → `.env`, задайте `AGENT_BOOTSTRAP_SECRET` **тестового** сервера
- Реестр: `config\registry.windows.example.json` → правьте пути к `.exe` под этот ПК
- `ALLOWED_DIRECTORIES=C:/Users/ВАШ_ЛОГИН/Documents,...`
- Для реальных действий: `ALLOW_REAL_ACTIONS=true`

Запуск из исходников (удобно для отладки):

```powershell
pnpm dev:agent
```

Или SEA с переменными окружения / диалогом секрета при первом старте. Код привязки введите в **тестовой** PWA.

### Если тестовый сервер на другой машине в сети

- `SERVER_PUBLIC_URL=https://test.example.com` (или `http://192.168.x.x:8787` только в LAN)
- Для удалённого HTTP агент **откажется** — нужен HTTPS (исключение: localhost/127.0.0.1)
- `localhost` в URL на Windows **не** укажет на удалённый Linux-сервер

Smoke после привязки телефона к тестовому серверу:

1. «Открой Telegram» / «Открой Chrome»
2. «Открой проект …»
3. «Какой заряд батареи»
4. «Заблокируй экран» — с подтверждением на телефоне

Когда проверка закончена — отвяжите тестовый токен и очистите локальные данные перед production:

```powershell
# SEA
powershell -ExecutionPolicy Bypass -File dist\windows\uninstall.ps1 -Purge
# или только сброс токена при следующем запуске:
# dauys-agent.exe --reset
```

---

## 3. Подключение к https://dauys.esl.kz (новая привязка)

Отдельный шаг **после** успешного теста. Не переносите токен/файлы из тестовой привязки.

1. Убедитесь, что установлен свежий агент (`install.ps1` или уже лежит в `%LOCALAPPDATA%\DauysAgent\bin\`).
2. Задайте bootstrap **боевого** сервера только на этом шаге:
   - переменная окружения `AGENT_BOOTSTRAP_SECRET`, или
   - ввод в диалоге при первом запуске SEA.
3. Для SEA по умолчанию сервер: `https://dauys.esl.kz`.  
   Если нужен явный URL: `$env:SERVER_PUBLIC_URL="https://dauys.esl.kz"`.
4. Запустите агент. Получите **новый** код привязки.
5. Откройте на телефоне https://dauys.esl.kz и введите этот код (не код с тестового стенда).
6. При смене сервера или отзыве токена: `dauys-agent.exe --reset`, затем новая привязка.

Реестр приложений на ПК: полные пути к `.exe` (см. `config\registry.windows.example.json`).  
`ALLOWED_DIRECTORIES` ограничьте нужными папками пользователя.

Удаление:

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge   # + токен и данные
```

---

## Состав архива (ожидаемый)

| Путь | Зачем |
|------|--------|
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | `pnpm install` |
| `apps/mac-agent`, `packages/shared` | исходники агента |
| `apps/server`, `apps/pwa` | workspace (lockfile) |
| `scripts/build-agent.mjs`, `tsup.agent.ts`, `fix-node-sqlite.mjs` | `pnpm build:agent:windows` |
| `packaging/windows/*` | install/uninstall + эта инструкция |
| `.env.windows-work.example`, `config/*.example.json` | шаблоны без секретов |

В архиве **нет**: `.git`, `node_modules`, `.env`, `*prod-copy*`, `data*`, БД, токены, `dist`, логи.
