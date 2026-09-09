#!/usr/bin/env node
/**
 * Архив для переноса на Windows 11 x64: исходники + lockfile + скрипты + инструкция.
 * Без секретов, БД, .git, node_modules, prod-copy, логов.
 */
import {
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const stageName = "dauys-windows-agent-src";
const outDir = join(root, "dist", "windows-transfer");
const stage = join(outDir, stageName);
const archiveZip = join(outDir, `${stageName}-${stamp}.zip`);
const archiveTgz = join(outDir, `${stageName}-${stamp}.tar.gz`);

const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".venv",
  "data",
  "data-windows-work",
  "deploy",
  "playwright-report",
  "test-results",
  "__pycache__",
  ".turbo",
  "coverage",
]);

const SKIP_FILE_SUBSTRINGS = [
  "prod-copy",
  "PROD-COPY",
  "DO-NOT-USE",
];

const SKIP_FILE_NAMES = new Set([
  ".env",
  ".DS_Store",
  "Thumbs.db",
]);

const SKIP_FILE_SUFFIXES = [
  ".log",
  ".db",
  ".db-shm",
  ".db-wal",
  ".pyc",
];

/** Explicit allow-list roots / files relative to repo root */
const INCLUDE = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "eslint.config.js",
  ".gitignore",
  ".prettierignore",
  ".env.example",
  ".env.windows-work.example",
  "README.md",
  "ARCHITECTURE.md",
  "SECURITY.md",
  "apps",
  "packages",
  "config",
  "packaging/windows",
  "scripts",
  "tests",
];

function shouldSkip(absPath, name, isDir) {
  if (SKIP_DIR_NAMES.has(name) && isDir) return true;
  if (SKIP_FILE_NAMES.has(name)) return true;
  if (SKIP_FILE_SUBSTRINGS.some((s) => name.includes(s) || absPath.includes(s)))
    return true;
  if (SKIP_FILE_SUFFIXES.some((s) => name.endsWith(s))) return true;
  if (name.startsWith(".env") && name !== ".env.example" && name !== ".env.windows-work.example")
    return true;
  return false;
}

function copyFiltered(src, dest) {
  const st = statSync(src);
  const name = src.split(/[/\\]/).pop();
  if (shouldSkip(src, name, st.isDirectory())) return;
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const child of readdirSync(src)) {
      copyFiltered(join(src, child), join(dest, child));
    }
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

function listFiles(dir, base = dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) listFiles(p, base, acc);
    else acc.push(relative(base, p).replace(/\\/g, "/"));
  }
  return acc;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const item of INCLUDE) {
  const src = join(root, item);
  if (!existsSync(src)) {
    console.warn("пропуск (нет файла): " + item);
    continue;
  }
  copyFiltered(src, join(stage, item));
}

writeFileSync(
  join(stage, "README.TRANSFER.txt"),
  [
    "Dauys — архив исходников для Windows 11 x64 (feature/windows-easy-install)",
    "",
    "1. Установите Node.js 24+ x64 и pnpm 11.",
    "2. Установите Inno Setup 6: https://jrsoftware.org/isdl.php",
    "3. Распакуйте архив, например в C:\\src\\dauys-agent",
    "4. pnpm install",
    "5. pnpm build:agent:windows-installer",
    "6. Установщик: dist\\windows-installer\\DauysSetup-x64.exe",
    "7. Чеклист VM: packaging\\windows\\VM-CHECKLIST.md",
    "8. Подробности: packaging\\windows\\BUILD-ON-WINDOWS.md",
    "",
    "localhost на Windows = этот ПК, не удалённый сервер.",
    "Секреты и production-конфиги в архив не входят.",
    "",
  ].join("\r\n"),
);

const required = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/mac-agent/package.json",
  "apps/mac-agent/src/index.ts",
  "apps/mac-agent/src/windows/executor.ts",
  "apps/mac-agent/src/windows/control-server.ts",
  "apps/mac-agent/src/windows/discover-apps.ts",
  "apps/mac-agent/src/windows/validate-exe.ts",
  "packages/shared/package.json",
  "packages/shared/src/index.ts",
  "apps/server/package.json",
  "apps/server/src/app.ts",
  "apps/pwa/package.json",
  "scripts/build-agent.mjs",
  "scripts/build-windows-installer.mjs",
  "scripts/tsup.agent.ts",
  "scripts/fix-node-sqlite.mjs",
  "packaging/windows/install.ps1",
  "packaging/windows/uninstall.ps1",
  "packaging/windows/DauysAcl.ps1",
  "packaging/windows/dauys-setup.iss",
  "packaging/windows/dauys-launch.vbs.template",
  "packaging/windows/BUILD-ON-WINDOWS.md",
  "packaging/windows/INSTALL.md",
  "packaging/windows/VM-CHECKLIST.md",
  "packaging/windows/SIGNING.md",
  ".env.windows-work.example",
  "config/registry.windows.example.json",
  "tsconfig.json",
];

const missing = required.filter((r) => !existsSync(join(stage, r)));
if (missing.length) {
  console.error("В stage не хватает:\n" + missing.join("\n"));
  process.exit(1);
}

const forbiddenHit = listFiles(stage).filter(
  (f) =>
    f.includes("prod-copy") ||
    f.includes("DO-NOT-USE") ||
    f === ".env" ||
    f.endsWith(".db") ||
    f.includes("node_modules") ||
    f.startsWith(".git/") ||
    f.includes("agent-token") ||
    f.includes("executions.db"),
);
if (forbiddenHit.length) {
  console.error("В архив попало запрещённое:\n" + forbiddenHit.join("\n"));
  process.exit(1);
}

const files = listFiles(stage);
writeFileSync(
  join(outDir, "MANIFEST.txt"),
  files.sort().join("\n") + "\n",
  "utf8",
);

function runArchive(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: outDir, stdio: "inherit" });
  if (r.status !== 0) throw new Error(cmd + " failed: " + r.status);
}

try {
  runArchive("zip", ["-r", "-q", archiveZip, stageName]);
} catch {
  console.warn("zip недоступен, только tar.gz");
}
runArchive("tar", ["-czf", archiveTgz, stageName]);

const zipOk = existsSync(archiveZip);
const pkg = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
if (!pkg.scripts?.["build:agent:windows-installer"]) {
  console.error("В package.json нет build:agent:windows-installer");
  process.exit(1);
}
if (!pkg.scripts?.["build:agent:windows"]) {
  console.error("В package.json нет build:agent:windows");
  process.exit(1);
}

console.log("Файлов в stage: " + files.length);
console.log("MANIFEST: " + join(outDir, "MANIFEST.txt"));
if (zipOk) console.log("ZIP: " + archiveZip);
console.log("TGZ: " + archiveTgz);
console.log("Инструкция: " + join(stageName, "packaging/windows/VM-CHECKLIST.md"));
