Рабочая копия для разработки Windows-агента.
Корень: /var/backups/dauys/dauys-windows-work-20260909-074311

НЕ менять /var/www/dauys.esl.kz и полный бэкап рядом в /var/backups/dauys/.
НЕ деплоить и НЕ перезапускать рабочие процессы с этой копии.

Конфигурация:
- Активный .env — из .env.windows-work.example (localhost, mock, data-windows-work/).
- Скопированный production .env → .env.prod-copy.DO-NOT-USE (не использовать).
- Production DB/реестр → data/prod-copy-DO-NOT-USE/ (не подключать).

Сборка SEA .exe — только на Windows 11 x64 (pnpm build:agent:windows).
На Linux: pnpm pack:windows-transfer → dist/windows-transfer/*.zip (исходники + lockfile + инструкция).
Также: pnpm pack:windows-kit → dist/windows-kit (скрипты установки без .exe).
Инструкция этапов: packaging/windows/BUILD-ON-WINDOWS.md
