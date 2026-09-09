#!/usr/bin/env node
/**
 * Готовит dist/windows-kit: скрипты установки и инструкция.
 * dauys-agent.exe сюда не кладётся — его собирают на Windows (pnpm build:agent:windows).
 */
import {
  copyFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist", "windows-kit");
const packaging = join(root, "packaging", "windows");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const name of [
  "install.ps1",
  "uninstall.ps1",
  "INSTALL.md",
  "BUILD-ON-WINDOWS.md",
  "DauysAcl.ps1",
  "SIGNING.md",
  "dauys-setup.iss",
  "dauys-launch.vbs.template",
]) {
  const src = join(packaging, name);
  if (existsSync(src)) copyFileSync(src, join(outDir, name));
}

copyFileSync(
  join(root, "config", "registry.windows.example.json"),
  join(outDir, "registry.windows.example.json"),
);
copyFileSync(
  join(root, "config", "agent-trust.example.json"),
  join(outDir, "agent-trust.example.json"),
);
if (existsSync(join(root, ".env.windows-work.example"))) {
  copyFileSync(
    join(root, ".env.windows-work.example"),
    join(outDir, "env.windows-work.example"),
  );
}

writeFileSync(
  join(outDir, "README.txt"),
  [
    "Рядом — комплект установки Windows-агента (Windows 11 x64)",
    "",
    "1. На Windows 11 x64 в корне репозитория:",
    "   pnpm install",
    "   pnpm build:agent:windows-installer",
    "   → dist\\windows-installer\\DauysSetup-x64.exe",
    "2. Либо только SEA: pnpm build:agent:windows → dist\\windows\\install.ps1",
    "3. Для пользователей: двойной клик по DauysSetup-x64.exe (без Node/pnpm).",
    "4. В мастере: адрес сервера + bootstrap-секрет → код на телефоне.",
    "",
    "Подробности: INSTALL.md / BUILD-ON-WINDOWS.md / SIGNING.md",
    "Данные агента: %LOCALAPPDATA%\\DauysAgent",
    "Автозапуск: Startup + VBS без консоли; статус в трее.",
    "",
    "Не подключайте агент к production и не используйте секреты из бэкапа.",
    "",
  ].join("\r\n"),
  { encoding: "utf8" },
);

writeFileSync(
  join(outDir, "PLACE_EXE_HERE.txt"),
  "Скопируйте сюда dauys-agent.exe после pnpm build:agent:windows на Windows 11 x64.\r\n",
  { encoding: "utf8" },
);

console.log("Готово: " + outDir);
console.log("На Windows: pnpm build:agent:windows → dist\\windows\\install.ps1");
