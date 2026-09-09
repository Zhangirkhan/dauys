import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  localAppsFileSchema,
  type LocalApp,
  type LocalAppsFile,
} from "../../../../packages/shared/src/index.js";
import {
  TRUSTED_SYSTEM_TARGETS,
  validateWindowsExecutable,
} from "./validate-exe.js";
import { protectUserFile } from "./protect.js";

export function defaultLocalApps(): LocalAppsFile {
  return {
    version: 1,
    apps: [
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
    ],
  };
}

export function appsPath(dataDir: string) {
  return resolve(dataDir, "agent-apps.json");
}

export async function loadLocalApps(dataDir: string): Promise<LocalAppsFile> {
  const path = appsPath(dataDir);
  try {
    return localAppsFileSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return defaultLocalApps();
    throw e;
  }
}

export async function saveLocalApps(
  dataDir: string,
  file: LocalAppsFile,
  helpersDir?: string,
) {
  const parsed = localAppsFileSchema.parse(file);
  // Re-validate executables before persist
  for (const app of parsed.apps) {
    if (app.kind === "exe") {
      app.executable = await validateWindowsExecutable(app.executable);
    }
  }
  const path = appsPath(dataDir);
  await writeFile(path, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  if (helpersDir && process.platform === "win32")
    await protectUserFile(path, helpersDir);
  return parsed;
}

export function catalogForServer(apps: LocalApp[]) {
  return apps
    .filter((a) => a.enabled)
    .map((a) => ({
      id: a.id,
      name: a.name,
      aliases: a.aliases,
    }));
}

export function findLocalApp(
  apps: LocalApp[],
  applicationId: string,
): LocalApp | undefined {
  return apps.find((a) => a.id === applicationId);
}

export function mergeDiscovered(
  current: LocalAppsFile,
  discovered: LocalApp[],
): LocalAppsFile {
  const byId = new Map(current.apps.map((a) => [a.id, a]));
  for (const d of discovered) {
    const prev = byId.get(d.id);
    if (prev) {
      // Keep user enabled flag and custom aliases if they edited
      byId.set(d.id, {
        ...d,
        enabled: prev.enabled,
        aliases:
          prev.aliases.length > (d.aliases?.length ?? 0)
            ? prev.aliases
            : d.aliases,
        name: prev.name || d.name,
      } as LocalApp);
    } else {
      byId.set(d.id, d);
    }
  }
  return { version: 1, apps: [...byId.values()] };
}
