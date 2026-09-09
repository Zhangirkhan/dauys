# Интеграция Windows + PWA status + server diagnostics

Дата: 2026-09-09  
Ветка: `integrate/windows-pwa-status-20260909`  
Каталог: `/var/backups/dauys/dauys-integrate-20260909` (git worktree от `main` @ `68928b3`)

## Источники

| Источник | Путь |
|----------|------|
| База Git | `/var/www/dauys.esl.kz` HEAD `68928b3` (без dirty WIP) |
| Windows-агент (проверено) | `/var/backups/dauys/dauys-windows-work-20260909-074311` |
| Deployed PWA+stages | `/var/backups/dauys/dauys-pwa-status-20260909/work` (= prod image) |
| Резерв WIP основного | `/var/backups/dauys/main-wip-backup-20260909-113357` |

Production **не менялся**.

## Что вошло

- Windows agent: `windows/*`, boot-log, ACL/SEA/packaging, platform hello
- Server: hello `platform`/`supportedActions` + stage/diagnostics + empty STT; **cross-platform строки** из Windows-копии
- PWA: статусы, confirmation/clarification (`App.tsx`/`style.css` из deployed)
- Shared: `isSafeAbsolutePath` (Win+POSIX)
- macOS packaging + `createExecutor()` → Mac на darwin

## Исключено

`.env*`, секреты, БД, токены, логи, `node_modules`, `dist`, `.env.prod-copy*`

## План переноса в `/var/www/dauys.esl.kz`

1. Убедиться, что WIP основного сохранён в `main-wip-backup-…` (уже есть).
2. В основном репо: `git stash push -u -m "pre-integrate"` **или** оставить WIP нетронутым и мержить только через cherry-pick/файлы.
3. `cd /var/www/dauys.esl.kz && git fetch` / при локальном worktree:  
   `git merge integrate/windows-pwa-status-20260909`  
   **либо** (безопаснее при грязном tree):  
   `git checkout integrate/windows-pwa-status-20260909 -- <paths>` по списку из коммита.
4. Разрешить конфликты с локальным Mac WIP вручную (ориентир: backup `files/`).
5. `pnpm install && pnpm test && pnpm build` в основном дереве.
6. Production деплой — **отдельным** согласованием (не этот шаг).

Альтернатива без merge в dirty tree:  
`rsync -a --relative` только файлов из `git show --name-only` коммита интеграции в MAIN, затем commit на `main`.
