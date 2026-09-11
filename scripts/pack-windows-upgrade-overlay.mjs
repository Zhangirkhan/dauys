#!/usr/bin/env node
/**
 * Лёгкий оверлей для уже распакованного архива на Windows VM:
 * только packaging/windows + связанные скрипты сборки установщика.
 * Без секретов / node_modules / dist.
 */
import {
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const stageName = "dauys-windows-upgrade-overlay";
const outDir = join(root, "dist", "windows-transfer");
const stage = join(outDir, stageName);
const archiveZip = join(outDir, `${stageName}-${stamp}.zip`);

const INCLUDE = [
  "packaging/windows/DauysAcl.ps1",
  "packaging/windows/Prepare-DauysUpgrade.ps1",
  "packaging/windows/dauys-setup.iss",
  "packaging/windows/install.ps1",
  "packaging/windows/uninstall.ps1",
  "packaging/windows/BUILD-ON-WINDOWS.md",
  "packaging/windows/INSTALL.md",
  "packaging/windows/VM-CHECKLIST.md",
  "scripts/build-agent.mjs",
  "scripts/build-windows-installer.mjs",
];

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const item of INCLUDE) {
  const src = join(root, item);
  if (!existsSync(src)) throw new Error("Нет файла: " + item);
  const dest = join(stage, item);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

writeFileSync(
  join(stage, "README.OVERLAY.txt"),
  [
    "Dauys — оверлей исправления обновления DauysSetup-x64.exe",
    "",
    "Проблема: DeleteFile код 5 на bin\\dauys-agent.exe при обновлении поверх.",
    "",
    "Причина: rename-probe был ложным (Windows: rename занятого exe OK, DeleteFile = код 5).",
    "Inno как раз вызывает DeleteFile. ACL-ошибки на exe раньше глотались.",
    "Исправление: стоп процессов сессии + ACL bin/helpers + реальное удаление exe до [Files];",
    "журнал %LOCALAPPDATA%\\DauysAgent\\upgrade-prepare.log (маркер UPGRADE_PREPARE_V2).",
    "",
    "1. Распакуйте ПОВЕРХ уже существующего дерева исходников на Windows, например:",
    "   C:\\src\\dauys-agent",
    "2. Команды пересборки установщика:",
    "   cd C:\\src\\dauys-agent",
    "   pnpm install",
    "   pnpm build:agent:windows-installer",
    "3. Новый файл: dist\\windows-installer\\DauysSetup-x64.exe",
    "4. На целевой VM запустите новый Setup поверх старой установки",
    "   (токен/привязка сохраняются; прав администратора не нужно).",
    "5. При сбое откройте upgrade-prepare.log — там процессы/ACL/delete.",
    "",
    "Ручная подготовка без пересборки (если Setup ещё старый):",
    "   powershell -NoProfile -ExecutionPolicy Bypass -File packaging\\windows\\Prepare-DauysUpgrade.ps1",
    "   затем снова DauysSetup-x64.exe",
    "",
    "Секреты в оверлей не входят.",
    "",
  ].join("\r\n"),
);

function listFiles(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listFiles(p, base, acc);
    else acc.push(relative(base, p).replace(/\\/g, "/"));
  }
  return acc;
}

const files = listFiles(stage);
writeFileSync(
  join(outDir, "OVERLAY-MANIFEST.txt"),
  files.sort().join("\n") + "\n",
);

const zip = spawnSync("zip", ["-r", "-q", archiveZip, stageName], {
  cwd: outDir,
  stdio: "inherit",
});
if (zip.status !== 0) throw new Error("zip failed");

console.log("Оверлей ZIP: " + archiveZip);
console.log("Файлов: " + files.length);
