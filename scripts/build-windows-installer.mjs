#!/usr/bin/env node
/**
 * Builds SEA agent + Inno Setup installer → dist/windows-installer/DauysSetup-x64.exe
 * Must run on Windows 11 x64 with Inno Setup 6 (ISCC) installed.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version || "0.1.0";
const outDir = join(root, "dist", "windows-installer");
const agentDir = join(root, "dist", "windows");
const iss = join(root, "packaging", "windows", "dauys-setup.iss");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (process.platform !== "win32") {
  fail(
    "Сборка установщика Windows возможна только на Windows 11 x64.\n" +
      "1) На Windows: pnpm build:agent:windows-installer\n" +
      "2) Либо на этой ОС: pnpm pack:windows-transfer — перенос исходников,\n" +
      "   затем на VM соберите установщик.\n" +
      "Артефакт: dist/windows-installer/DauysSetup-x64.exe",
  );
}

mkdirSync(outDir, { recursive: true });

console.log("→ SEA-агент (версия " + version + ")…");
const build = spawnSync(
  process.execPath,
  [join(root, "scripts/build-agent.mjs"), "--windows"],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DAUYS_AGENT_VERSION: version },
  },
);
if (build.status !== 0) fail("Сборка dauys-agent.exe не удалась");

const exe = join(agentDir, "dauys-agent.exe");
if (!existsSync(exe)) fail("Не найден " + exe);

const acl = join(agentDir, "DauysAcl.ps1");
if (!existsSync(acl)) {
  copyFileSync(
    join(root, "packaging/windows/DauysAcl.ps1"),
    acl,
  );
}

function findIscc() {
  if (process.env.ISCC_PATH && existsSync(process.env.ISCC_PATH))
    return process.env.ISCC_PATH;
  const candidates = [
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe"),
    join(process.env.ProgramFiles || "C:\\Program Files", "Inno Setup 6", "ISCC.exe"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const iscc = findIscc();
if (!iscc) {
  fail(
    "Не найден Inno Setup 6 (ISCC.exe).\n" +
      "Установите: https://jrsoftware.org/isdl.php\n" +
      "Или задайте ISCC_PATH=C:\\Path\\to\\ISCC.exe",
  );
}

console.log("→ Inno Setup: " + iscc);
const issResult = spawnSync(
  iscc,
  [
    "/DMyAppVersion=" + version,
    "/DSourceAgentDir=" + agentDir,
    iss,
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DAUYS_AGENT_VERSION: version },
  },
);
if (issResult.status !== 0) fail("Inno Setup завершился с ошибкой");

const setup = join(outDir, "DauysSetup-x64.exe");
if (!existsSync(setup)) fail("Ожидался файл " + setup);

writeFileSync(
  join(outDir, "README.txt"),
  [
    "Dauys Windows installer " + version,
    "",
    "Файл: DauysSetup-x64.exe",
    "Установка: двойной клик, без прав администратора.",
    "Каталог: %LOCALAPPDATA%\\DauysAgent",
    "Подпись: см. packaging/windows/SIGNING.md",
    "",
  ].join("\r\n"),
);

console.log("\nГотово: " + setup);
console.log("Версия: " + version);
console.log("Подпись (опционально): packaging/windows/SIGNING.md\n");
