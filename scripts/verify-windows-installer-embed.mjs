#!/usr/bin/env node
/**
 * Verify upgrade scripts are packaged into DauysSetup-x64.exe.
 * Linux: uses wine64 + NuGet ISCC (or ISCC_PATH). Windows: uses local ISCC.
 * Proves embedding with a Compression=none build, then rebuilds normal lzma Setup (stub exe OK on Linux).
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iss = join(root, "packaging/windows/dauys-setup.iss");
const agentDir = join(root, "dist/windows");
const outDir = join(root, "dist/windows-installer");
const setup = join(outDir, "DauysSetup-x64.exe");
const prep = join(root, "packaging/windows/Prepare-DauysUpgrade.ps1");
const acl = join(root, "packaging/windows/DauysAcl.ps1");
const report = join(outDir, "VERIFY-UPGRADE-EMBED.txt");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function findIscc() {
  if (process.env.ISCC_PATH && existsSync(process.env.ISCC_PATH))
    return { cmd: process.env.ISCC_PATH, via: "env" };
  if (process.platform === "win32") {
    const candidates = [
      join(process.env["ProgramFiles(x86)"] || "", "Inno Setup 6", "ISCC.exe"),
      join(process.env.ProgramFiles || "", "Inno Setup 6", "ISCC.exe"),
      join(process.env.ProgramFiles || "", "Inno Setup 7", "ISCC.exe"),
    ];
    for (const c of candidates) if (c && existsSync(c)) return { cmd: c, via: "path" };
  }
  const nugetIscc = join(
    "/tmp/innosetup-check/nuget/innosetup-nuget/tools/ISCC.exe",
  );
  if (existsSync(nugetIscc)) return { cmd: nugetIscc, via: "wine-nuget", wine: true };
  return null;
}

mkdirSync(agentDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
if (!existsSync(join(agentDir, "dauys-agent.exe"))) {
  writeFileSync(
    join(agentDir, "dauys-agent.exe"),
    "MZ stub for packaging verification only\n",
  );
}
copyFileSync(acl, join(agentDir, "DauysAcl.ps1"));

const iscc = findIscc();
if (!iscc) fail("ISCC.exe не найден (ISCC_PATH или NuGet tools)");

const agentDirArg =
  process.platform === "win32"
    ? agentDir
    : "Z:" + agentDir.replace(/\//g, "\\");
const issArg =
  process.platform === "win32" ? iss : "Z:" + iss.replace(/\//g, "\\");

function runIscc(extraDefines) {
  const args = [
    "/DMyAppVersion=0.1.0",
    "/DSourceAgentDir=" + agentDirArg,
    ...extraDefines,
    issArg,
  ];
  let r;
  if (iscc.wine) {
    r = spawnSync(
      "xvfb-run",
      ["-a", "wine64", iscc.cmd, ...args],
      { cwd: dirname(iscc.cmd), encoding: "utf8" },
    );
  } else {
    r = spawnSync(iscc.cmd, args, { cwd: root, encoding: "utf8" });
  }
  if (r.status !== 0) {
    console.error(r.stdout || "");
    console.error(r.stderr || "");
    fail("ISCC failed");
  }
  return (r.stdout || "") + (r.stderr || "");
}

console.log("→ Plain embed check (Compression=none)…");
const plainLog = runIscc(["/DDauysVerifyPlain=1"]);
if (!existsSync(setup)) fail("нет " + setup);
const plainBytes = readFileSync(setup);
const prepBytes = readFileSync(prep);
const aclBytes = readFileSync(acl);
const checks = [
  ["Prepare body", prepBytes],
  ["DauysAcl body", aclBytes],
  ["DestDir dauys-upgrade", Buffer.from("dauys-upgrade")],
  ["Prepare filename", Buffer.from("Prepare-DauysUpgrade.ps1")],
  ["Acl filename", Buffer.from("DauysAcl.ps1")],
  ["marker V3", Buffer.from("UPGRADE_PREPARE_V3")],
  ["bootstrap log fn", Buffer.from("Write-BootstrapLog")],
];
const lines = [];
lines.push("Dauys upgrade embed verification");
lines.push("date=" + new Date().toISOString());
lines.push("iscc=" + iscc.cmd + " via=" + iscc.via);
lines.push("plain_setup_bytes=" + plainBytes.length);
for (const [name, buf] of checks) {
  const ok = plainBytes.includes(buf);
  lines.push((ok ? "OK  " : "FAIL") + " " + name + " size=" + buf.length);
  if (!ok) fail("VERIFY FAIL: " + name);
}

console.log("→ Production compress check…");
const prodLog = runIscc([]);
const prodStat = statSync(setup);
const compressed =
  /Compressing:.*Prepare-DauysUpgrade\.ps1/i.test(prodLog) &&
  /Compressing:.*DauysAcl\.ps1/i.test(prodLog) &&
  /Successful compile/i.test(prodLog);
lines.push(
  compressed
    ? "OK  ISCC compressed both upgrade scripts (lzma)"
    : "FAIL ISCC compress log missing scripts",
);
if (!compressed) fail("VERIFY FAIL: compress log");
lines.push("prod_setup_bytes=" + prodStat.size);
lines.push("NOTE: prod Setup here may use stub dauys-agent.exe on Linux — rebuild SEA on Windows VM.");
lines.push("VERIFY_OK");
writeFileSync(report, lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.log("Report: " + report);
