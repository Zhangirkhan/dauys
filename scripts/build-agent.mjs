#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromRoot = createRequire(join(root, "package.json"));
const target = process.argv.includes("--windows")
  ? "windows"
  : process.argv.includes("--macos")
    ? "macos"
    : process.platform === "win32"
      ? "windows"
      : "macos";

if (target === "macos" && process.platform === "win32") {
  console.error("Сборка macOS-агента нужна на macOS (codesign / Mach-O).");
  process.exit(1);
}
if (target === "windows" && process.platform !== "win32") {
  console.error(
    "SEA-бинарник Windows (dauys-agent.exe) собирайте на Windows 11 x64 с Node 24+.\n" +
      "На этой ОС: pnpm pack:windows-kit — комплект скриптов и инструкции без .exe.\n" +
      "Нельзя копировать Linux/macOS node в dauys-agent.exe.",
  );
  process.exit(1);
}

const outDir = join(root, "dist", target);
const bundleDir = join(outDir, "bundle");
const blob = join(outDir, "sea-prep.blob");
const binary = join(
  outDir,
  target === "windows" ? "dauys-agent.exe" : "dauys-agent",
);
const config = join(outDir, "sea-config.json");

/** Resolve package bin entry to an absolute .js path (run via node, no .cmd). */
function packageBin(pkgName, binName = pkgName) {
  const pkgJsonPath = requireFromRoot.resolve(pkgName + "/package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const binField = pkg.bin;
  const rel =
    typeof binField === "string"
      ? binField
      : binField?.[binName] ?? binField?.[pkgName];
  if (!rel)
    throw new Error("В пакете " + pkgName + " нет bin «" + binName + "»");
  const abs = join(dirname(pkgJsonPath), rel);
  if (!existsSync(abs)) throw new Error("Не найден CLI: " + abs);
  return abs;
}

function isJsScript(file) {
  return /\.[cm]?js$/i.test(file);
}

function isWindowsBatch(file) {
  return /\.(cmd|bat)$/i.test(file);
}

/** Quote one argument for cmd.exe /s /c (no shell:true + args → DEP0190). */
function quoteForCmd(arg) {
  const s = String(arg);
  if (s.length === 0) return '""';
  if (!/[\s"&<>|^()]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * Find pnpm.cmd / tool on PATH without executing through shell:true+args.
 * Returns absolute path or the original name.
 */
function resolveOnPath(command) {
  if (command.includes("/") || command.includes("\\")) return command;
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  const names =
    process.platform === "win32" && !/\.[^.]+$/.test(command)
      ? [command, ...exts.map((ext) => command + ext)]
      : [command];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

/**
 * Spawn without shell:true+args.
 * - node / *.exe / *.js → прямой CreateProcess + argv
 * - *.cmd / *.bat на Windows → cmd.exe /d /s /c с одной строкой команды
 */
function run(command, args = [], extra = {}) {
  let file = command;
  let argv = [...args];
  let windowsVerbatimArguments = false;

  if (isJsScript(file)) {
    argv = [file, ...argv];
    file = process.execPath;
  }

  if (process.platform === "win32") {
    const resolved =
      file === process.execPath || /\.exe$/i.test(file)
        ? file
        : resolveOnPath(file);
    file = resolved;
    if (isWindowsBatch(file)) {
      const line = [quoteForCmd(file), ...argv.map(quoteForCmd)].join(" ");
      file = process.env.ComSpec || "cmd.exe";
      argv = ["/d", "/s", "/c", line];
      windowsVerbatimArguments = true;
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, {
      cwd: root,
      stdio: "inherit",
      shell: false,
      windowsVerbatimArguments,
      env: process.env,
      ...extra,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              [file, ...argv].join(" ") + " -> " + code,
            ),
          ),
    );
  });
}

function runNode(scriptArgs) {
  return run(process.execPath, scriptArgs);
}

mkdirSync(outDir, { recursive: true });
rmSync(bundleDir, { recursive: true, force: true });
rmSync(blob, { force: true });
rmSync(binary, { force: true });

const tsupCli = packageBin("tsup");
await runNode([
  tsupCli,
  "--config",
  join(root, "scripts/tsup.agent.ts"),
  "--out-dir",
  bundleDir,
]);
const bundled = readdirSync(bundleDir).find((name) =>
  /^index\.(cjs|js)$/.test(name),
);
if (!bundled) throw new Error("tsup не собрал index.cjs / index.js");
const bundle = join(bundleDir, bundled);
await runNode([join(root, "scripts/fix-node-sqlite.mjs"), bundle]);

writeFileSync(
  config,
  JSON.stringify(
    {
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useCodeCache: true,
    },
    null,
    2,
  ),
);

await runNode(["--experimental-sea-config", config]);
copyFileSync(process.execPath, binary);
if (target !== "windows") chmodSync(binary, 0o755);

const postjectCli = packageBin("postject");

if (target === "macos") {
  await run("codesign", ["--remove-signature", binary]);
  await runNode([
    postjectCli,
    binary,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--macho-segment-name",
    "NODE_SEA",
    "--overwrite",
  ]);
  await run("codesign", ["--force", "--sign", "-", binary]);
  for (const name of ["install.sh", "uninstall.sh"]) {
    const src = join(root, "packaging/macos", name);
    copyFileSync(src, join(outDir, name));
    chmodSync(join(outDir, name), 0o755);
  }
} else {
  await runNode([
    postjectCli,
    binary,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--overwrite",
  ]);
  for (const name of [
    "install.ps1",
    "uninstall.ps1",
    "DauysAcl.ps1",
    "Prepare-DauysUpgrade.ps1",
  ]) {
    copyFileSync(
      join(root, "packaging/windows", name),
      join(outDir, name),
    );
  }
  copyFileSync(
    join(root, "packaging/windows/INSTALL.md"),
    join(outDir, "INSTALL.md"),
  );
  writeFileSync(
    join(outDir, "README.txt"),
    [
      "Рядом — Windows-агент",
      "",
      "1. SEA: powershell -ExecutionPolicy Bypass -File .\\install.ps1",
      "2. Либо из корня репозитория: скопируйте .env.windows-work.example → .env и pnpm dev:agent",
      "3. Введите AGENT_BOOTSTRAP_SECRET тестового сервера при первом запуске.",
      "4. Код привязки введите в PWA (адрес из SERVER_PUBLIC_URL).",
      "",
      "Подробности: INSTALL.md",
      "Данные: %LOCALAPPDATA%\\DauysAgent",
      "Автозапуск: папка Startup текущего пользователя (не служба).",
      "",
    ].join("\r\n"),
  );
}

console.log("\nГотово: " + binary);
if (target === "macos")
  console.log("Установка: " + join(outDir, "install.sh") + "\n");
else console.log("Установка: " + join(outDir, "install.ps1") + "\n");
