import { describe, expect, it } from "vitest";
import {
  assertWindowsPathSyntax,
  isWithinWindows,
  normalizeWindowsPath,
} from "../apps/mac-agent/src/windows/path.js";
import { isSafeAbsolutePath } from "../packages/shared/src/index.js";
import { WinExecutor } from "../apps/mac-agent/src/windows/executor.js";
import { supportedActionsForPlatform } from "../apps/mac-agent/src/platform.js";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { guardPath } from "../apps/mac-agent/src/safety.js";
import { ensureWindowsHelpers } from "../apps/mac-agent/src/windows/protect.js";

describe("Windows path syntax", () => {
  it("accepts drive-absolute paths and rejects UNC, ADS, drive-relative", () => {
    expect(isSafeAbsolutePath("C:\\Users\\a\\file.pdf")).toBe(true);
    expect(isSafeAbsolutePath("C:/Users/a/file.pdf")).toBe(true);
    expect(isSafeAbsolutePath("/Users/a/file.pdf")).toBe(true);
    expect(isSafeAbsolutePath("C:folder")).toBe(false);
    expect(isSafeAbsolutePath("\\\\server\\share")).toBe(false);
    expect(isSafeAbsolutePath("C:\\Users\\a:stream")).toBe(false);
    expect(() => assertWindowsPathSyntax("C:folder")).toThrow(/Drive-relative/);
    expect(() => assertWindowsPathSyntax("\\\\server\\share")).toThrow(/UNC/);
    expect(() => assertWindowsPathSyntax("C:\\a:b")).toThrow(/Streams/);
  });

  it("checks containment by component boundary, case-insensitive", () => {
    expect(isWithinWindows("C:\\docs\\ok.pdf", "C:\\docs")).toBe(true);
    expect(isWithinWindows("C:\\Docs\\ok.pdf", "C:\\docs")).toBe(true);
    expect(isWithinWindows("C:\\docs-private\\x.pdf", "C:\\docs")).toBe(false);
    expect(isWithinWindows("C:\\docs", "C:\\docs")).toBe(true);
    expect(
      normalizeWindowsPath("C:/docs/../docs/a.pdf").toLowerCase(),
    ).toContain("docs");
  });
});

describe("Windows capabilities", () => {
  it("lists supported actions and hides run_shortcut without processes", () => {
    const withProc = supportedActionsForPlatform("win32", {
      shortcuts: [{ id: "s1", name: "Demo" }],
      processes: {
        s1: {
          executable: "C:\\Tools\\demo.exe",
          args: [],
          cwd: "C:\\Tools",
        },
      },
    });
    expect(withProc).toContain("run_shortcut");
    const without = supportedActionsForPlatform("win32", {
      shortcuts: [],
      processes: {},
    });
    expect(without).not.toContain("run_shortcut");
  });

  it("mock executor never claims unsupported success for missing app path", async () => {
    const executor = new WinExecutor({
      real: false,
      roots: [],
      trust: { shortcuts: [], processes: {} },
      dataDir: ".",
    });
    const result = await executor.execute(
      { action: "open_application", parameters: { applicationId: "chrome" } },
      {
        projects: [],
        applications: [{ id: "chrome", name: "Google Chrome", aliases: [] }],
      },
    );
    // mock skips path requirement
    expect(result.success).toBe(true);
    expect(result.data?.mock).toBe(true);
  });
});

describe("path guard with Windows-style roots on current OS", () => {
  it("still blocks sibling-prefix and symlink escape on POSIX roots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "voice-winpath-"));
    try {
      const allowed = join(dir, "docs");
      await mkdir(allowed);
      await mkdir(allowed + "-private");
      await writeFile(join(allowed, "ok.pdf"), "document");
      await writeFile(join(allowed + "-private", "secret.pdf"), "private");
      await symlink(
        join(allowed + "-private", "secret.pdf"),
        join(allowed, "escape.pdf"),
      );
      expect(await guardPath(join(allowed, "ok.pdf"), [allowed])).toContain(
        "ok.pdf",
      );
      await expect(
        guardPath(join(allowed, "escape.pdf"), [allowed]),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "blocks junction escape on Windows",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "voice-junc-"));
      try {
        const allowed = join(dir, "docs");
        const priv = join(dir, "docs-private");
        await mkdir(allowed);
        await mkdir(priv);
        await writeFile(join(priv, "secret.pdf"), "private");
        // Create junction via mklink (needs no admin for directory junction)
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFile);
        await exec("cmd.exe", [
          "/c",
          "mklink",
          "/J",
          join(allowed, "escape"),
          priv,
        ]);
        await expect(
          guardPath(join(allowed, "escape", "secret.pdf"), [allowed]),
        ).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("Windows helpers content", () => {
  it("does not assign to PowerShell automatic $PID in foreground.ps1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "voice-helpers-"));
    try {
      const helpers = await ensureWindowsHelpers(dir);
      const body = await readFile(join(helpers, "foreground.ps1"), "utf8");
      expect(body).toMatch(/\$fgPid/);
      expect(body).not.toMatch(/\[uint32\]\$pid\b/);
      const box = await readFile(join(helpers, "message-box.ps1"), "utf8");
      expect(box).toMatch(/MessageBox/);
      const protect = await readFile(join(helpers, "protect-file.ps1"));
      expect(protect[0]).toBe(0xef);
      expect(protect[1]).toBe(0xbb);
      expect(protect[2]).toBe(0xbf);
      const protectText = protect.toString("utf8");
      expect(protectText).toMatch(/ContainerInherit/);
      expect(protectText).toMatch(/ObjectInherit/);
      expect(protectText).toMatch(/WindowsIdentity]::GetCurrent/);
      expect(protectText).toMatch(/PSIsContainer/);
      expect(protectText).toMatch(/AccessControlSections]::Access/);
      expect(protectText).toMatch(/GetAccessControl/);
      expect(protectText).toMatch(/SetAccessControl/);
      expect(protectText).not.toMatch(/Set-Acl\s+-LiteralPath/);
      expect(protectText).not.toMatch(/Get-Acl\s+-LiteralPath/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
