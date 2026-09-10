import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalApp } from "../../../../packages/shared/src/index.js";
import {
  TRUSTED_SYSTEM_TARGETS,
  validateWindowsExecutable,
  isUnsafeShortcutTarget,
} from "./validate-exe.js";
import {
  ensureWindowsHelpers,
  helperPath,
  runFixedPs1,
} from "./protect.js";

type KnownSpec = {
  id: string;
  name: string;
  aliases: string[];
  candidates: string[];
};

function expand(p: string) {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const roaming = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 =
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return p
    .replace(/%LOCALAPPDATA%/gi, local)
    .replace(/%APPDATA%/gi, roaming)
    .replace(/%ProgramFiles%/gi, pf)
    .replace(/%ProgramFiles\(x86\)%/gi, pf86)
    .replace(/%USERPROFILE%/gi, homedir());
}

const KNOWN: KnownSpec[] = [
  {
    id: "chrome",
    name: "Google Chrome",
    aliases: ["хром", "гугл хром", "chrome", "google chrome"],
    candidates: [
      "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
      "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
      "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
    ],
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    aliases: ["edge", "эдж", "microsoft edge", "майкрософт эдж"],
    candidates: [
      "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
  },
  {
    id: "firefox",
    name: "Firefox",
    aliases: ["firefox", "файрфокс", "мозилла"],
    candidates: [
      "%ProgramFiles%\\Mozilla Firefox\\firefox.exe",
      "%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe",
    ],
  },
  {
    id: "telegram",
    name: "Telegram",
    aliases: ["телеграм", "телега", "тг", "telegram"],
    candidates: [
      "%APPDATA%\\Telegram Desktop\\Telegram.exe",
      "%LOCALAPPDATA%\\Telegram Desktop\\Telegram.exe",
      "%ProgramFiles%\\Telegram Desktop\\Telegram.exe",
    ],
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    aliases: ["ватсап", "вацап", "whatsapp", "whats app"],
    candidates: [
      "%LOCALAPPDATA%\\WhatsApp\\WhatsApp.exe",
      "%ProgramFiles%\\WindowsApps\\*WhatsApp*\\WhatsApp.exe",
    ],
  },
  {
    id: "discord",
    name: "Discord",
    aliases: ["дискорд", "discord"],
    candidates: [
      "%LOCALAPPDATA%\\Discord\\Update.exe",
      "%LOCALAPPDATA%\\Discord\\app-*\\Discord.exe",
    ],
  },
  {
    id: "spotify",
    name: "Spotify",
    aliases: ["спотифай", "spotify"],
    candidates: [
      "%APPDATA%\\Spotify\\Spotify.exe",
      "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\Spotify.exe",
    ],
  },
  {
    id: "vscode",
    name: "Visual Studio Code",
    aliases: ["vs code", "vscode", "вс код", "код", "visual studio code"],
    candidates: [
      "%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe",
      "%ProgramFiles%\\Microsoft VS Code\\Code.exe",
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    aliases: ["курсор", "cursor"],
    candidates: [
      "%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe",
      "%LOCALAPPDATA%\\Programs\\Cursor\\Cursor.exe",
    ],
  },
];

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const raw of candidates) {
    if (raw.includes("*")) continue; // wildcard — only via PS discovery
    const path = expand(raw);
    try {
      await access(path);
      return await validateWindowsExecutable(path);
    } catch {
      continue;
    }
  }
  return null;
}

async function discoverFromShortcuts(dataDir: string): Promise<LocalApp[]> {
  if (process.platform !== "win32") return [];
  try {
    const helpers = await ensureWindowsHelpers(dataDir);
    const out = await runFixedPs1(
      helperPath(helpers, "discover-apps.ps1"),
      [],
      { timeout: 60_000 },
    );
    if (!out) return [];
    const rows = JSON.parse(out) as Array<{
      id?: string;
      name: string;
      path: string;
      args?: string;
    }>;
    const apps: LocalApp[] = [];
    for (const row of rows) {
      if (isUnsafeShortcutTarget(row.path, row.args ?? "")) continue;
      try {
        const exe = await validateWindowsExecutable(row.path);
        const id =
          row.id ??
          ("app-" +
            Buffer.from(exe.toLowerCase())
              .toString("base64url")
              .replace(/=+$/, "")
              .slice(0, 16));
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) continue;
        apps.push({
          kind: "exe",
          id,
          name: row.name.slice(0, 80),
          aliases: [row.name.toLocaleLowerCase()].slice(0, 30),
          executable: exe,
          enabled: true,
        });
      } catch {
        continue;
      }
    }
    return apps;
  } catch {
    return [];
  }
}

export async function discoverInstalledApps(
  dataDir: string,
): Promise<LocalApp[]> {
  const found: LocalApp[] = [
    {
      kind: "system",
      id: "settings",
      name: TRUSTED_SYSTEM_TARGETS.settings.name,
      aliases: [...TRUSTED_SYSTEM_TARGETS.settings.aliases],
      enabled: true,
    },
    {
      kind: "system",
      id: "explorer",
      name: TRUSTED_SYSTEM_TARGETS.explorer.name,
      aliases: [...TRUSTED_SYSTEM_TARGETS.explorer.aliases],
      enabled: true,
    },
  ];

  const knownIds = new Set<string>(["settings", "explorer"]);

  for (const spec of KNOWN) {
    const path = await firstExisting(spec.candidates);
    if (!path) continue;
    found.push({
      kind: "exe",
      id: spec.id,
      name: spec.name,
      aliases: spec.aliases,
      executable: path,
      enabled: true,
    });
    knownIds.add(spec.id);
  }

  // Discord often lives under versioned app-* — try Update.exe sibling via config
  if (!knownIds.has("discord") && process.platform === "win32") {
    try {
      const base = expand("%LOCALAPPDATA%\\Discord");
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(base, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || !e.name.startsWith("app-")) continue;
        const exe = join(base, e.name, "Discord.exe");
        try {
          const validated = await validateWindowsExecutable(exe);
          found.push({
            kind: "exe",
            id: "discord",
            name: "Discord",
            aliases: ["дискорд", "discord"],
            executable: validated,
            enabled: true,
          });
          knownIds.add("discord");
          break;
        } catch {
          continue;
        }
      }
    } catch {
      /* optional */
    }
  }

  const fromMenu = await discoverFromShortcuts(dataDir);
  for (const app of fromMenu) {
    if (knownIds.has(app.id)) continue;
    // Prefer matching known names
    const known = KNOWN.find(
      (k) =>
        k.name.toLocaleLowerCase() === app.name.toLocaleLowerCase() ||
        k.aliases.some(
          (a) => a.toLocaleLowerCase() === app.name.toLocaleLowerCase(),
        ),
    );
    if (known && app.kind === "exe") {
      if (!knownIds.has(known.id)) {
        found.push({
          ...app,
          id: known.id,
          name: known.name,
          aliases: known.aliases,
        });
        knownIds.add(known.id);
      }
      continue;
    }
    if (app.kind === "exe") {
      found.push(app);
      knownIds.add(app.id);
    }
  }

  return found;
}

/** Read App Paths registry via helper output file — optional enrichment. */
export async function readAppPathsHint(_dataDir: string): Promise<string[]> {
  try {
    // Soft read of a few well-known App Paths without registry write
    const candidates = [
      expand(
        "%LOCALAPPDATA%\\Microsoft\\Windows\\WinX\\Group2\\2 - Run.lnk",
      ),
    ];
    const existing: string[] = [];
    for (const c of candidates) {
      try {
        await readFile(c);
        existing.push(c);
      } catch {
        /* skip */
      }
    }
    return existing;
  } catch {
    return [];
  }
}
