#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist/macos");
const bundleDir = join(outDir, "bundle");
const blob = join(outDir, "sea-prep.blob");
const binary = join(outDir, "dauys-agent");
const config = join(outDir, "sea-config.json");

function run(command, args, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      ...extra,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(command + " " + args.join(" ") + " -> " + code)),
    );
  });
}

mkdirSync(outDir, { recursive: true });
rmSync(bundleDir, { recursive: true, force: true });
rmSync(blob, { force: true });
rmSync(binary, { force: true });

await run("pnpm", [
  "exec",
  "tsup",
  "--config",
  "scripts/tsup.agent.ts",
  "--out-dir",
  bundleDir,
]);
const bundled = readdirSync(bundleDir).find((name) =>
  /^index\.(cjs|js)$/.test(name),
);
if (!bundled) throw new Error("tsup не собрал index.cjs / index.js");
const bundle = join(bundleDir, bundled);
await run("node", ["scripts/fix-node-sqlite.mjs", bundle]);

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

await run(process.execPath, ["--experimental-sea-config", config]);
copyFileSync(process.execPath, binary);
chmodSync(binary, 0o755);
await run("codesign", ["--remove-signature", binary]);
await run("pnpm", [
  "exec",
  "postject",
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

console.log("\nГотово: " + binary);
console.log("Установка: " + join(outDir, "install.sh") + "\n");
