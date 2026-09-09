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

for (const name of ["install.ps1", "uninstall.ps1", "INSTALL.md", "BUILD-ON-WINDOWS.md", "DauysAcl.ps1"]) {
  copyFileSync(join(packaging, name), join(outDir, name));
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
    "   pnpm build:agent:windows",
    "2. Скопируйте dist\\windows\\dauys-agent.exe в эту папку (рядом с install.ps1)",
    "   либо запускайте install.ps1 из dist\\windows после сборки.",
    "3. powershell -ExecutionPolicy Bypass -File .\\install.ps1",
    "4. Введите AGENT_BOOTSTRAP_SECRET тестового сервера.",
    "5. Код привязки введите в PWA (SERVER_PUBLIC_URL / адрес сервера).",
    "",
    "Подробности: INSTALL.md",
    "Данные агента: %LOCALAPPDATA%\\DauysAgent",
    "Автозапуск: Startup текущего пользователя (не служба).",
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
