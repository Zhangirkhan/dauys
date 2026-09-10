import { readFile, writeFile, mkdir, chmod, rm } from "node:fs/promises";
import { basename, dirname, resolve, join } from "node:path";
import { hostname } from "node:os";
import { isSea } from "node:sea";
import { execFile } from "node:child_process";
import { z } from "zod";
import { trustSchema } from "../../../packages/shared/src/index.js";
import type { AgentConfig, LocalApp } from "../../../packages/shared/src/index.js";
import { ExecutionLedger } from "./safety.js";
import { AgentClient, type ConnectionState } from "./client.js";
import { askBootstrapSecret, showPairingCode } from "./dialog.js";
import { logger } from "./logger.js";
import {
  bootErr,
  bootLog,
  bootProcessBanner,
  bootStageDone,
  bootStageFail,
  bootStageStart,
} from "./boot-log.js";
import {
  agentDataDir,
  defaultAllowedDirectories,
  defaultRealActions,
  defaultServerUrl,
  isStandalone,
} from "./paths.js";
import { createExecutor, platformId } from "./platform.js";
import { AGENT_VERSION } from "./agent-version.js";
import {
  ensureWindowsHelpers,
  helperPath,
  protectUserFile,
  runFixedPs1,
} from "./windows/protect.js";
import {
  acquireSingleInstance,
  SingleInstanceError,
} from "./windows/single-instance.js";
import {
  ensureStartMenuShortcut,
  isAutostartEnabled,
  setAutostart,
} from "./windows/autostart.js";
import {
  openLocalUrl,
  startControlServer,
  type ControlServer,
  type RecentOp,
} from "./windows/control-server.js";
import { startTray, type TrayHandle } from "./windows/tray.js";
import {
  loadAgentConfig,
  saveAgentConfig,
} from "./windows/agent-config.js";
import {
  catalogForServer,
  loadLocalApps,
  mergeDiscovered,
  saveLocalApps,
} from "./windows/apps-store.js";
import { discoverInstalledApps } from "./windows/discover-apps.js";

export { AGENT_VERSION };

function hideConsoleWindow() {
  if (process.platform !== "win32") return;
  try {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Add-Type -Name W -Namespace N -MemberDefinition '[DllImport(\"kernel32.dll\")]public static extern IntPtr GetConsoleWindow();[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int n);';[void][N.W]::ShowWindow([N.W]::GetConsoleWindow(),0)",
      ],
      { windowsHide: true },
      () => undefined,
    );
  } catch {
    /* optional */
  }
}

async function pairWithServer(o: {
  base: string;
  token?: string;
  bootstrap?: string;
  name?: string;
}) {
  const pairUrl = new URL("/api/auth/pair/start", o.base);
  const response = await fetch(pairUrl, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + (o.token ?? o.bootstrap ?? ""),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: o.name ?? hostname() }),
    signal: AbortSignal.timeout(10000),
  });
  const raw = await response.json();
  if (!response.ok)
    throw new Error(
      "Не удалось создать код привязки. Сервер ответил HTTP " +
        response.status,
    );
  return z
    .object({
      data: z.object({
        token: z.string().optional(),
        code: z.string(),
        expiresAt: z.number(),
        deviceId: z.string(),
      }),
    })
    .parse(raw).data;
}

async function fetchAgentStatus(base: string, token: string) {
  try {
    const r = await fetch(new URL("/api/agent/status", base), {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const raw = await r.json();
    return z
      .object({
        data: z.object({
          paired: z.boolean(),
          clients: z.number(),
        }),
      })
      .parse(raw).data;
  } catch {
    return null;
  }
}

async function runWindowsStandalone(o: {
  dataDir: string;
  tokenPath: string;
  trustPath: string;
  helpersDir: string;
  reset: boolean;
  wantPair: boolean;
  wantSettings: boolean;
}) {
  const releaseLock = await acquireSingleInstance(o.dataDir);
  let config = await loadAgentConfig(o.dataDir);
  let hasTokenFlag = false;
  if (o.reset) {
    await rm(o.tokenPath, { force: true });
    hasTokenFlag = false;
    config = await saveAgentConfig(
      o.dataDir,
      { ...config, setupCompleted: false },
      o.helpersDir,
    );
  }

  let connection: ConnectionState = "offline";
  let pairedFlag = false;
  let agent: AgentClient | undefined;
  const tray: { current?: TrayHandle } = {};
  let control: ControlServer | undefined;
  let localApps = await loadLocalApps(o.dataDir);
  const recentOps: RecentOp[] = [];
  let setupResolve: (() => void) | undefined;
  const setupDone = new Promise<void>((r) => {
    setupResolve = r;
  });

  const pushOp = (action: string, message: string) => {
    recentOps.unshift({
      at: new Date().toISOString().slice(11, 19),
      action,
      message: message.slice(0, 120),
    });
    if (recentOps.length > 30) recentOps.pop();
  };

  const readToken = async (): Promise<string | undefined> => {
    try {
      const stored = z
        .object({ token: z.string().min(32), server: z.string() })
        .parse(JSON.parse(await readFile(o.tokenPath, "utf8")));
      return stored.token;
    } catch {
      return undefined;
    }
  };

  const writeToken = async (token: string, server: string) => {
    await writeFile(o.tokenPath, JSON.stringify({ token, server }), {
      mode: 0o600,
    });
    await protectUserFile(o.tokenPath, o.helpersDir);
    hasTokenFlag = true;
  };

  if (!o.reset) hasTokenFlag = Boolean(await readToken());

  const rootsFor = (cfg: AgentConfig) =>
    cfg.allowedDirectories.length
      ? cfg.allowedDirectories
      : defaultAllowedDirectories();

  let trust;
  try {
    trust = trustSchema.parse(JSON.parse(await readFile(o.trustPath, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    trust = trustSchema.parse({ shortcuts: [], processes: {} });
    await writeFile(o.trustPath, JSON.stringify(trust, null, 2), {
      mode: 0o600,
    });
  }
  await protectUserFile(o.trustPath, o.helpersDir).catch(() => undefined);

  const ledgerPath = resolve(dirname(o.tokenPath), "executions.db");
  const ledger = new ExecutionLedger(ledgerPath);
  await protectUserFile(ledgerPath, o.helpersDir).catch(() => undefined);

  const realActions = defaultRealActions();
  let executor = createExecutor({
    real: realActions,
    roots: rootsFor(config),
    trust,
    dataDir: dirname(o.tokenPath),
    localApps: localApps.apps,
  });

  const connectAgent = async (token: string, serverUrl: string) => {
    agent?.close();
    const url = new URL(serverUrl);
    url.pathname = "/ws/mac-agent";
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    connection = "connecting";
    agent = new AgentClient({
      url: url.toString(),
      token,
      executor,
      ledger,
      logger,
      capabilities: {
        realActions,
        shortcuts: trust.shortcuts,
        platform: platformId(),
        supportedActions: executor.supportedActions(),
      },
      onConnectionChange: (s) => {
        connection = s;
      },
      onAuthFailure: () => {
        logger.error(
          "Токен отозван. Для новой привязки запустите: dauys-agent --reset",
        );
        process.exit(0);
      },
    });
    agent.sendAppsCatalog(catalogForServer(localApps.apps));
    agent.connect();
  };

  const openLogFile = async () => {
    const logPath = join(o.dataDir, "agent.log");
    try {
      await writeFile(logPath, "", { flag: "a" });
    } catch {
      /* ok */
    }
    execFile(
      "notepad.exe",
      [logPath],
      { windowsHide: true },
      () => undefined,
    );
  };

  // Assigned after hooks are created so early quit/settings calls remain safe.
  // eslint-disable-next-line prefer-const
  control = await startControlServer({
    getState: () => ({
      connection,
      server: config.serverUrl,
      paired: pairedFlag || (hasTokenFlag && connection === "connected"),
      hasToken: hasTokenFlag,
      version: AGENT_VERSION,
      folders: config.allowedDirectories,
      autostart: config.autostart,
      apps: localApps.apps.map((a) => ({
        id: a.id,
        name: a.name,
        aliases: a.aliases,
        enabled: a.enabled,
      })),
      recentOps: [...recentOps],
      setupCompleted: config.setupCompleted,
    }),
    testConnection: async (serverUrl, _bootstrap) => {
      const u = new URL(serverUrl);
      if (
        u.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      )
        throw new Error("Для удалённого сервера требуется HTTPS.");
      const r = await fetch(new URL("/health", serverUrl), {
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error("Сервер ответил HTTP " + r.status);
      config = await saveAgentConfig(
        o.dataDir,
        { ...config, serverUrl },
        o.helpersDir,
      );
      const existing = await readToken();
      hasTokenFlag = Boolean(existing);
      if (existing) {
        await connectAgent(existing, serverUrl);
        // Brief wait for WS hello
        for (let i = 0; i < 20 && connection !== "connected"; i++)
          await new Promise((r) => setTimeout(r, 150));
      }
      return { hasToken: hasTokenFlag, connection };
    },
    startPair: async (serverUrl, bootstrap) => {
      const existing = await readToken();
      hasTokenFlag = Boolean(existing);
      if (!existing && !(bootstrap && bootstrap.trim()))
        throw new Error(
          "Введите bootstrap-секрет с сервера. Поле нельзя оставлять пустым при первой привязке.",
        );
      const data = await pairWithServer({
        base: serverUrl,
        token: existing,
        bootstrap: existing ? undefined : bootstrap?.trim(),
      });
      const token = data.token ?? existing;
      if (!token) throw new Error("Сервер не вернул токен");
      await writeToken(token, serverUrl);
      config = await saveAgentConfig(
        o.dataDir,
        { ...config, serverUrl },
        o.helpersDir,
      );
      pairedFlag = false;
      await connectAgent(token, serverUrl);
      return { code: data.code, expiresAt: data.expiresAt };
    },
    pairStatus: async () => {
      const token = await readToken();
      hasTokenFlag = Boolean(token);
      if (!token)
        return { paired: false, hasToken: false, agentOnline: false };
      const online = connection === "connected";
      const st = await fetchAgentStatus(config.serverUrl, token);
      // Old production without /api/agent/status → st is null; token+WS is enough.
      if (st) {
        pairedFlag = st.paired;
        return {
          paired: st.paired || online,
          hasToken: true,
          agentOnline: online,
        };
      }
      if (online) pairedFlag = true;
      return {
        paired: online || pairedFlag,
        hasToken: true,
        agentOnline: online,
      };
    },
    ensureConnected: async () => {
      const token = await readToken();
      hasTokenFlag = Boolean(token);
      if (!token)
        throw new Error(
          "Локальная привязка не найдена. Введите bootstrap-секрет и получите код.",
        );
      await connectAgent(token, config.serverUrl);
      for (let i = 0; i < 30 && connection !== "connected"; i++)
        await new Promise((r) => setTimeout(r, 200));
      if (connection === "connected") pairedFlag = true;
      return { hasToken: true, connection };
    },
    pickFolder: async () => {
      const picked = await runFixedPs1(
        helperPath(o.helpersDir, "folder-picker.ps1"),
        ["-Description", "Папка для Dauys"],
        { interactive: true },
      );
      if (!picked) return config.allowedDirectories;
      if (!config.allowedDirectories.includes(picked)) {
        config = await saveAgentConfig(
          o.dataDir,
          {
            ...config,
            allowedDirectories: [...config.allowedDirectories, picked],
          },
          o.helpersDir,
        );
        executor = createExecutor({
          real: realActions,
          roots: rootsFor(config),
          trust,
          dataDir: dirname(o.tokenPath),
          localApps: localApps.apps,
        });
      }
      return config.allowedDirectories;
    },
    discoverApps: async () => {
      const found = await discoverInstalledApps(o.dataDir);
      localApps = await saveLocalApps(
        o.dataDir,
        mergeDiscovered(localApps, found),
        o.helpersDir,
      );
      executor.setLocalApps?.(localApps.apps);
      pushOp("discover-apps", "найдено " + localApps.apps.length);
      return localApps.apps;
    },
    saveAppToggles: async (toggles) => {
      const map = new Map(toggles.map((t) => [t.id, t.enabled]));
      localApps = {
        version: 1,
        apps: localApps.apps.map((a) =>
          map.has(a.id) ? ({ ...a, enabled: map.get(a.id)! } as LocalApp) : a,
        ),
      };
      localApps = await saveLocalApps(o.dataDir, localApps, o.helpersDir);
      executor.setLocalApps?.(localApps.apps);
      agent?.sendAppsCatalog(catalogForServer(localApps.apps));
    },
    updateApps: async (apps) => {
      const byId = new Map(apps.map((a) => [a.id, a]));
      localApps = {
        version: 1,
        apps: localApps.apps.map((a) => {
          const u = byId.get(a.id);
          if (!u) return a;
          return {
            ...a,
            ...(u.enabled !== undefined ? { enabled: u.enabled } : {}),
            ...(u.aliases ? { aliases: u.aliases } : {}),
          } as LocalApp;
        }),
      };
      localApps = await saveLocalApps(o.dataDir, localApps, o.helpersDir);
      executor.setLocalApps?.(localApps.apps);
      agent?.sendAppsCatalog(catalogForServer(localApps.apps));
    },
    completeSetup: async () => {
      if (config.autostart) await setAutostart(true);
      await ensureStartMenuShortcut();
      config = await saveAgentConfig(
        o.dataDir,
        { ...config, setupCompleted: true, agentVersion: AGENT_VERSION },
        o.helpersDir,
      );
      setupResolve?.();
    },
    testCommand: async () => {
      const result = await executor.execute(
        { action: "get_battery_status", parameters: {} },
        { projects: [], applications: [] },
      );
      pushOp("test-command", result.message);
      return result;
    },
    saveConfig: async (patch) => {
      config = await saveAgentConfig(
        o.dataDir,
        { ...config, ...patch },
        o.helpersDir,
      );
      if (patch.allowedDirectories) {
        executor = createExecutor({
          real: realActions,
          roots: rootsFor(config),
          trust,
          dataDir: dirname(o.tokenPath),
          localApps: localApps.apps,
        });
      }
    },
    toggleAutostart: async () => {
      const next = !(await isAutostartEnabled());
      await setAutostart(next);
      config = await saveAgentConfig(
        o.dataDir,
        { ...config, autostart: next },
        o.helpersDir,
      );
      return { autostart: next };
    },
    pairAgain: async () => {
      const token = await readToken();
      if (!token) throw new Error("Нет токена — пройдите настройку");
      const data = await pairWithServer({
        base: config.serverUrl,
        token,
      });
      pairedFlag = false;
      return { code: data.code, expiresAt: data.expiresAt };
    },
    reconnect: async () => {
      const token = await readToken();
      if (!token) throw new Error("Нет токена");
      await connectAgent(token, config.serverUrl);
    },
    openLog: openLogFile,
    openSettings: async () => {
      if (control) openLocalUrl(control.settingsUrl);
    },
    quit: async () => {
      tray.current?.stop();
      agent?.close();
      ledger.close();
      await control?.close().catch(() => undefined);
      await releaseLock();
      process.exit(0);
    },
  });

  const needWizard = !config.setupCompleted || o.reset;
  if (needWizard) {
    bootLog("opening setup wizard");
    // Resume saved binding during upgrade before UI asks for bootstrap.
    if (hasTokenFlag) {
      const existing = await readToken();
      if (existing) {
        await connectAgent(existing, config.serverUrl).catch(() => undefined);
      }
    }
    openLocalUrl(control.wizardUrl);
    await setupDone;
  } else if (o.wantSettings) {
    openLocalUrl(control.settingsUrl);
  } else if (o.wantPair) {
    openLocalUrl(control.settingsUrl);
  }

  hideConsoleWindow();
  if (config.autostart) {
    await setAutostart(true).catch(() => undefined);
    await ensureStartMenuShortcut().catch(() => undefined);
  }

  tray.current = startTray({
    helpersDir: o.helpersDir,
    baseUrl: control.baseUrl,
    token: control.token,
  });

  const token = await readToken();
  if (!token) throw new Error("Нет токена агента после настройки");

  // Apply SERVER_PUBLIC_URL override from env if set
  const serverUrl = process.env.SERVER_PUBLIC_URL || config.serverUrl;
  if (process.env.ALLOWED_DIRECTORIES) {
    const dirs = process.env.ALLOWED_DIRECTORIES.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (dirs.length) {
      config = await saveAgentConfig(
        o.dataDir,
        { ...config, allowedDirectories: dirs },
        o.helpersDir,
      );
      executor = createExecutor({
        real: realActions,
        roots: rootsFor(config),
        trust,
        dataDir: dirname(o.tokenPath),
        localApps: localApps.apps,
      });
    }
  }

  await connectAgent(token, serverUrl);
  const st = await fetchAgentStatus(serverUrl, token);
  if (st) pairedFlag = st.paired;

  logger.info(
    {
      realActions,
      dataDir: o.dataDir,
      server: serverUrl,
      platform: platformId(),
      version: AGENT_VERSION,
    },
    "Режим агента Windows",
  );
  bootLog("windows standalone running");

  void Promise.resolve(executor.warmProjects?.())
    .then(() => undefined)
    .catch((e: unknown) =>
      logger.warn(
        { message: e instanceof Error ? e.message : String(e) },
        "Индекс проектов",
      ),
    );

  for (const s of ["SIGINT", "SIGTERM"] as const)
    process.on(s, () => {
      tray.current?.stop();
      agent?.close();
      ledger.close();
      void control?.close();
      void releaseLock().finally(() => process.exit(0));
    });
}

async function main() {
  const standalone = isStandalone();
  let sea = false;
  try {
    sea = isSea();
  } catch {
    sea = false;
  }
  bootProcessBanner({
    platform: process.platform,
    standalone,
    sea,
    execPath: process.execPath,
  });

  if (!standalone) {
    bootStageStart("dotenv");
    await import("dotenv/config");
    bootStageDone("dotenv");
  } else {
    bootLog("skip dotenv (standalone/SEA)");
  }

  const env = process.env;
  bootStageStart("resolvePaths");
  const dataDir = agentDataDir();
  const tokenPath = env.AGENT_TOKEN_PATH ?? resolve(dataDir, "agent-token.json");
  const trustPath = env.AGENT_TRUST_PATH ?? resolve(dataDir, "agent-trust.json");
  const reset = process.argv.includes("--reset");
  const wantPairDialog = reset || process.argv.includes("--pair");
  const wantSettings = process.argv.includes("--settings");
  bootStageDone("resolvePaths", {
    dataDir,
    reset,
    pairFlag: wantPairDialog,
    settingsFlag: wantSettings,
    hasBootstrapEnv: Boolean(env.AGENT_BOOTSTRAP_SECRET),
  });

  bootStageStart("mkdirData");
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  bootStageDone("mkdirData");

  let helpersDir = "";
  if (process.platform === "win32") {
    bootStageStart("ensureWindowsHelpers", { dataDir });
    try {
      helpersDir = await ensureWindowsHelpers(dataDir);
      bootStageDone("ensureWindowsHelpers", {
        helpers: basename(helpersDir),
      });
    } catch (e) {
      bootStageFail("ensureWindowsHelpers", e);
      throw e;
    }
  }

  if (process.platform === "win32" && standalone) {
    try {
      await runWindowsStandalone({
        dataDir,
        tokenPath,
        trustPath,
        helpersDir,
        reset,
        wantPair: wantPairDialog,
        wantSettings,
      });
    } catch (e) {
      if (e instanceof SingleInstanceError) {
        console.error(e.message);
        process.exit(1);
      }
      throw e;
    }
    return;
  }

  const base = env.SERVER_PUBLIC_URL ?? defaultServerUrl();
  const url = new URL(base);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Для удалённого сервера требуется HTTPS.");

  if (reset) {
    bootStageStart("resetToken");
    await rm(tokenPath, { force: true });
    bootStageDone("resetToken");
  }

  let token: string | undefined;
  let hadToken = false;
  try {
    bootStageStart("readToken");
    const stored = z
      .object({ token: z.string().min(32), server: z.string() })
      .parse(JSON.parse(await readFile(tokenPath, "utf8")));
    if (stored.server !== base)
      throw new Error("Сервер изменился: запустите агент с --reset");
    token = stored.token;
    hadToken = true;
    bootStageDone("readToken", { hasToken: true });
    if (process.platform !== "win32") await chmod(tokenPath, 0o600);
    else if (helpersDir) {
      bootStageStart("protectTokenExisting");
      try {
        await protectUserFile(tokenPath, helpersDir);
        bootStageDone("protectTokenExisting");
      } catch (e) {
        bootStageFail("protectTokenExisting", e);
        throw e;
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      bootStageFail("readToken", e);
      throw e;
    }
    bootStageDone("readToken", { hasToken: false });
  }

  let bootstrap = env.AGENT_BOOTSTRAP_SECRET;
  if (!token && !bootstrap && standalone) {
    bootLog("no token — requesting bootstrap via dialog");
    bootstrap = await askBootstrapSecret();
  }
  if (!token && !bootstrap)
    throw new Error(
      "Запустите pnpm setup:env или задайте AGENT_BOOTSTRAP_SECRET.",
    );

  const pairUrl = new URL("/api/auth/pair/start", base);
  bootStageStart("pairStart", {
    host: pairUrl.host,
    path: pairUrl.pathname,
    auth: token ? "stored-token" : "bootstrap-env-or-dialog",
    timeoutMs: 10000,
  });
  let response: Response;
  try {
    response = await fetch(pairUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + (token ?? bootstrap),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: hostname() }),
      signal: AbortSignal.timeout(10000),
    });
    bootStageDone("pairStart", { httpStatus: response.status });
  } catch (e) {
    bootStageFail("pairStart", e);
    throw e;
  }

  bootStageStart("pairParse");
  const raw = await response.json();
  if (!response.ok) {
    bootStageFail("pairParse", new Error("HTTP " + response.status));
    throw new Error(
      "Не удалось создать код привязки: " +
        JSON.stringify(raw) +
        ". При отзыве токена используйте --reset.",
    );
  }
  const data = z
    .object({
      data: z.object({
        token: z.string().optional(),
        code: z.string(),
        expiresAt: z.number(),
        deviceId: z.string(),
      }),
    })
    .parse(raw).data;
  token = data.token ?? token;
  if (!token) throw new Error("Сервер не вернул токен");
  bootStageDone("pairParse", {
    hasCode: Boolean(data.code),
    deviceIdLen: data.deviceId.length,
  });

  bootStageStart("writeToken");
  await writeFile(tokenPath, JSON.stringify({ token, server: base }), {
    mode: 0o600,
  });
  bootStageDone("writeToken");
  if (process.platform === "win32" && helpersDir) {
    bootStageStart("protectTokenNew");
    try {
      await protectUserFile(tokenPath, helpersDir);
      bootStageDone("protectTokenNew");
    } catch (e) {
      bootStageFail("protectTokenNew", e);
      throw e;
    }
  }

  console.log(
    "\n  Код привязки телефона: " +
      data.code +
      " (5 минут)\n  Откройте " +
      base +
      " и введите этот код. Для нового кода: dauys-agent --pair\n",
  );
  if (!hadToken || wantPairDialog) showPairingCode(data.code, base);

  let trust;
  try {
    bootStageStart("loadTrust");
    trust = trustSchema.parse(JSON.parse(await readFile(trustPath, "utf8")));
    bootStageDone("loadTrust", { existing: true });
    if (process.platform === "win32" && helpersDir) {
      bootStageStart("protectTrust");
      try {
        await protectUserFile(trustPath, helpersDir);
        bootStageDone("protectTrust");
      } catch (e) {
        bootStageFail("protectTrust", e);
        throw e;
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      bootStageFail("loadTrust", e);
      throw e;
    }
    trust = trustSchema.parse({ shortcuts: [], processes: {} });
    await writeFile(trustPath, JSON.stringify(trust, null, 2), { mode: 0o600 });
    bootStageDone("loadTrust", { existing: false });
    if (process.platform === "win32" && helpersDir) {
      bootStageStart("protectTrust");
      try {
        await protectUserFile(trustPath, helpersDir);
        bootStageDone("protectTrust");
      } catch (e2) {
        bootStageFail("protectTrust", e2);
        throw e2;
      }
    }
  }

  const ledgerPath = resolve(dirname(tokenPath), "executions.db");
  bootStageStart("openLedger");
  const ledger = new ExecutionLedger(ledgerPath);
  bootStageDone("openLedger");
  if (process.platform === "win32" && helpersDir) {
    bootStageStart("protectLedger");
    try {
      await protectUserFile(ledgerPath, helpersDir);
      bootStageDone("protectLedger");
    } catch (e) {
      bootStageFail("protectLedger", e);
      /* db may be locked briefly; token/trust already protected */
    }
  }

  const realActions = defaultRealActions();
  bootStageStart("createExecutor");
  const localApps =
    process.platform === "win32"
      ? (await loadLocalApps(dataDir)).apps
      : undefined;
  const executor = createExecutor({
    real: realActions,
    roots: (env.ALLOWED_DIRECTORIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .concat(env.ALLOWED_DIRECTORIES ? [] : defaultAllowedDirectories()),
    trust,
    dataDir: dirname(tokenPath),
    localApps,
  });
  bootStageDone("createExecutor", {
    realActions,
    platform: platformId(),
  });

  url.pathname = "/ws/mac-agent";
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  bootStageStart("wsConnect", { host: url.host, path: url.pathname });
  const agent = new AgentClient({
    url: url.toString(),
    token,
    executor,
    ledger,
    logger,
    capabilities: {
      realActions,
      shortcuts: trust.shortcuts,
      platform: platformId(),
      supportedActions: executor.supportedActions(),
    },
    onConnectionChange: (state) => {
      if (state === "connected" && localApps)
        agent.sendAppsCatalog(catalogForServer(localApps));
    },
    onAuthFailure: () => {
      logger.error(
        "Токен отозван. Для новой привязки запустите: dauys-agent --reset",
      );
      process.exit(0);
    },
  });
  agent.connect();
  bootStageDone("wsConnect", { note: "handshake async; см. лог «Агент подключён»" });
  logger.info(
    { realActions, dataDir, server: base, platform: platformId() },
    "Режим агента",
  );
  bootLog("startup sequence finished (agent running)");
  void Promise.resolve(executor.warmProjects?.())
    .then(() => undefined)
    .catch((e: unknown) =>
      logger.warn(
        { message: e instanceof Error ? e.message : String(e) },
        "Индекс проектов",
      ),
    );
  for (const s of ["SIGINT", "SIGTERM"] as const)
    process.on(s, () => {
      agent.close();
      ledger.close();
      process.exit(0);
    });
}

void main().catch((error) => {
  bootErr("fatal", error);
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
