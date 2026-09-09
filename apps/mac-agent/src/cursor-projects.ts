import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scoreSpokenLabel } from "./spoken-name.js";

export type CursorProject = {
  key: string;
  name: string;
  path: string;
  uri: string;
  host?: string;
  local: boolean;
  recency: number;
};

const MARKERS = [
  ".git",
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "composer.json",
  "Gemfile",
  "docker-compose.yml",
  "Makefile",
];
const SKIP =
  /^(Library|Applications|node_modules|dist|build|vendor|venv|Music|Movies|Pictures|Public|\$RECYCLE\.BIN)$/i;

export function projectKey(uri: string) {
  return createHash("sha256").update(uri).digest("hex").slice(0, 12);
}

/** Only Remote-SSH is supported: WSL, tunnels and dev containers cannot be reached from here. */
function decodeAuthority(authority: string) {
  const raw = decodeURIComponent(authority);
  const plus = raw.indexOf("+");
  if (plus < 0 || raw.slice(0, plus).toLowerCase() !== "ssh-remote")
    return undefined;
  const value = raw.slice(plus + 1);
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    try {
      const json = JSON.parse(Buffer.from(value, "hex").toString("utf8"));
      const host = (json as { hostName?: unknown }).hostName;
      if (typeof host === "string" && host) return host;
    } catch {
      return undefined;
    }
  }
  return value || undefined;
}

export function parseFolderUri(uri: string): CursorProject | undefined {
  const match = /^([a-zA-Z][\w.+-]*):\/\/([^/]*)(\/.*)$/.exec(uri);
  if (!match) return undefined;
  const [, scheme, authority, encoded] = match;
  let path: string;
  try {
    path = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  if (/[\x00-\x1f]/.test(path)) return undefined;
  const name = basename(path.replace(/\/+$/, "")) || path;
  if (!name) return undefined;
  if (scheme === "file")
    return { key: projectKey(uri), name, path, uri, local: true, recency: 0 };
  if (scheme !== "vscode-remote") return undefined;
  const host = decodeAuthority(authority);
  if (!host) return undefined;
  return {
    key: projectKey(uri),
    name,
    path,
    uri,
    host,
    local: false,
    recency: 0,
  };
}

export function cursorStatePath() {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return join(
    homedir(),
    "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
  );
}

export function readCursorHistory(dbPath = cursorStatePath()) {
  let db: DatabaseSync | undefined;
  let value: unknown;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare("select value from ItemTable where key = ?")
      .get("history.recentlyOpenedPathsList");
    value = row?.value;
  } catch {
    return [];
  } finally {
    db?.close();
  }
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const out: CursorProject[] = [];
  for (const entry of entries) {
    const uri = (entry as { folderUri?: unknown }).folderUri;
    if (typeof uri !== "string") continue;
    const project = parseFolderUri(uri);
    if (project) out.push({ ...project, recency: out.length });
  }
  return out;
}

export async function readWorkspaceStorage() {
  const root =
    process.platform === "win32"
      ? join(
          process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
          "Cursor",
          "User",
          "workspaceStorage",
        )
      : join(
          homedir(),
          "Library/Application Support/Cursor/User/workspaceStorage",
        );
  const out: CursorProject[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    try {
      const raw = await readFile(join(root, dir, "workspace.json"), "utf8");
      const folder = (JSON.parse(raw) as { folder?: unknown }).folder;
      if (typeof folder !== "string") continue;
      const project = parseFolderUri(folder);
      if (project) out.push({ ...project, recency: 500 });
    } catch {
      continue;
    }
  }
  return out;
}

async function looksLikeProject(dir: string, names: Set<string>) {
  if (names.has(".git")) return true;
  for (const marker of MARKERS) if (names.has(marker)) return true;
  for (const name of names) if (name.endsWith(".xcodeproj")) return true;
  void dir;
  return false;
}

export async function scanLocalProjects(roots: string[], maxDepth = 4) {
  const found = new Map<string, CursorProject>();
  const walk = async (dir: string, depth: number) => {
    if (depth > maxDepth || found.size >= 400) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    if (depth > 0 && (await looksLikeProject(dir, names))) {
      const uri = pathToFileURL(dir).href;
      found.set(dir, {
        key: projectKey(uri),
        name: basename(dir),
        path: dir,
        uri,
        local: true,
        recency: 900,
      });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || SKIP.test(entry.name)) continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  };
  for (const root of roots) await walk(root, 0);
  return [...found.values()];
}

export function allowedSshHosts(configText: string, extra = "") {
  const hosts = new Set<string>();
  for (const line of configText.split("\n")) {
    const match = /^\s*Host\s+(.+?)\s*$/i.exec(line);
    if (!match) continue;
    for (const host of match[1].split(/\s+/))
      if (host && !host.includes("*") && !host.includes("?")) hosts.add(host);
  }
  for (const host of extra.split(",").map((s) => s.trim()))
    if (host) hosts.add(host);
  return hosts;
}

export function guardRemoteUri(uri: string, hosts: Set<string>) {
  if (uri.length > 2048) throw new Error("Слишком длинный адрес проекта");
  if (!/^vscode-remote:\/\/ssh-remote(%2B|\+)/i.test(uri))
    throw new Error("Поддерживаются только SSH-проекты Cursor");
  if (/[\x00-\x1f"'`$\\]/.test(uri) || uri.includes("@"))
    throw new Error("Небезопасный адрес проекта");
  const project = parseFolderUri(uri);
  if (!project?.host) throw new Error("Не разобрал SSH-хост проекта");
  if (!hosts.has(project.host))
    throw new Error(
      "Хост " +
        project.host +
        " не описан в ~/.ssh/config. Добавьте его или ALLOWED_SSH_HOSTS.",
    );
  return project;
}

export type RemoteExec = (
  file: string,
  args: string[],
) => Promise<string>;

const SAFE_REMOTE_DIR = /^\/[A-Za-z0-9._/-]{1,120}$/;
/** Listing these would return system directories, not projects. */
const SYSTEM_DIRS =
  /^\/(var|root|home|etc|usr|opt|srv|tmp|bin|sbin|lib|mnt|media|proc|sys|dev)?$/;

/** Parent directories that already proved to hold projects on each host. */
export function remoteRootsFromHistory(projects: CursorProject[], perHost = 6) {
  const roots = new Map<string, Set<string>>();
  for (const project of projects) {
    if (project.local || !project.host) continue;
    const parent = project.path.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
    if (!parent || !SAFE_REMOTE_DIR.test(parent)) continue;
    if (SYSTEM_DIRS.test(parent)) continue;
    const set = roots.get(project.host) ?? new Set<string>();
    if (set.size < perHost) set.add(parent);
    roots.set(project.host, set);
  }
  return roots;
}

export async function listRemoteProjects(
  host: string,
  dirs: string[],
  exec: RemoteExec,
) {
  const safe = [...new Set(dirs)].filter((dir) => SAFE_REMOTE_DIR.test(dir));
  if (!safe.length || !/^[A-Za-z0-9._-]{1,120}$/.test(host))
    return { paths: [] as string[], listed: [] as string[] };
  const out = await exec("/usr/bin/ssh", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "StrictHostKeyChecking=accept-new",
    host,
    "find " +
      safe.join(" ") +
      " -mindepth 1 -maxdepth 1 -type d -not -name '.*' 2>/dev/null",
  ]);
  const paths = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"));
  return { paths, listed: safe };
}

export function remoteProjectsFrom(
  host: string,
  paths: string[],
  recency = 800,
) {
  const out: CursorProject[] = [];
  for (const path of paths) {
    const uri =
      "vscode-remote://ssh-remote%2B" +
      Buffer.from(JSON.stringify({ hostName: host }), "utf8").toString("hex") +
      encodeURI(path);
    const project = parseFolderUri(uri);
    if (project) out.push({ ...project, recency });
  }
  return out;
}

/** History keeps folders that were deleted on the server; opening those lands on the parent. */
export function dropStaleRemote(
  projects: CursorProject[],
  listing: Map<string, { paths: Set<string>; listed: Set<string> }>,
) {
  return projects.filter((project) => {
    if (project.local || !project.host) return true;
    const known = listing.get(project.host);
    if (!known) return true;
    const path = project.path.replace(/\/+$/, "");
    const parent = path.replace(/\/[^/]+$/, "");
    if (!known.listed.has(parent)) return true;
    return known.paths.has(path);
  });
}

export function dedupeProjects(lists: CursorProject[][]) {
  const byUri = new Map<string, CursorProject>();
  for (const list of lists)
    for (const project of list) {
      const existing = byUri.get(project.uri);
      if (!existing || project.recency < existing.recency)
        byUri.set(project.uri, project);
    }
  return [...byUri.values()];
}

export function matchProjects(
  projects: CursorProject[],
  query: string,
  host?: string,
) {
  const wanted = host ? scoreSpokenLabel(host, host) : 0;
  void wanted;
  const scored = projects
    .map((project) => {
      let score = scoreSpokenLabel(project.name, query);
      if (score > 0 && project.path !== project.name) {
        const viaPath = scoreSpokenLabel(
          project.path.split("/").slice(-2).join(" "),
          query,
        );
        score = Math.max(score, viaPath - 40);
      }
      if (host) {
        const hostScore = project.host
          ? scoreSpokenLabel(project.host, host)
          : 0;
        if (hostScore < 400) score = 0;
        else score += 100;
      }
      return { project, score };
    })
    .filter((item) => item.score >= 400)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.project.recency - b.project.recency ||
        a.project.path.length - b.project.path.length,
    );
  if (!scored.length) return { matches: [] as CursorProject[] };
  const best = scored[0].score;
  const close = scored.filter((item) => item.score >= best - 30);
  return {
    matches: (close.length > 1 ? close : [scored[0]]).map((i) => i.project),
  };
}

type RemoteListing = Map<string, { paths: Set<string>; listed: Set<string> }>;

export class CursorProjectIndex {
  private cache?: { at: number; projects: CursorProject[] };
  private scan?: { at: number; projects: CursorProject[] };
  private scanning?: Promise<CursorProject[]>;
  private remote?: {
    at: number;
    projects: CursorProject[];
    listing: RemoteListing;
  };
  private listing?: Promise<void>;
  constructor(
    private o: {
      roots: string[];
      historyTtlMs?: number;
      scanTtlMs?: number;
      remoteTtlMs?: number;
      ssh?: RemoteExec;
    },
  ) {}
  private async remoteProjects() {
    const ttl = this.o.remoteTtlMs ?? 600_000;
    if (this.remote && Date.now() - this.remote.at < ttl) return this.remote;
    const ssh = this.o.ssh;
    if (!ssh) return undefined;
    if (!this.listing) {
      const roots = remoteRootsFromHistory(await this.history(true));
      this.listing = (async () => {
        const projects: CursorProject[] = [];
        const listing: RemoteListing = new Map();
        await Promise.all(
          [...roots].map(async ([host, dirs]) => {
            try {
              const { paths, listed } = await listRemoteProjects(
                host,
                [...dirs],
                ssh,
              );
              // An empty answer means the host refused us, not that it has no projects.
              if (!listed.length || !paths.length) return;
              listing.set(host, {
                paths: new Set(paths),
                listed: new Set(listed),
              });
              projects.push(...remoteProjectsFrom(host, paths));
            } catch {
              return;
            }
          }),
        );
        this.remote = { at: Date.now(), projects, listing };
      })().finally(() => {
        this.listing = undefined;
      });
    }
    await this.listing;
    return this.remote;
  }
  private async history(raw = false) {
    const ttl = this.o.historyTtlMs ?? 30_000;
    if (this.cache && Date.now() - this.cache.at < ttl)
      return raw
        ? this.cache.projects
        : dropStaleRemote(this.cache.projects, this.remote?.listing ?? new Map());
    const projects = dedupeProjects([
      readCursorHistory(),
      await readWorkspaceStorage(),
    ]);
    const alive: CursorProject[] = [];
    for (const project of projects) {
      if (!project.local) {
        alive.push(project);
        continue;
      }
      try {
        if ((await stat(project.path)).isDirectory()) alive.push(project);
      } catch {
        continue;
      }
    }
    this.cache = { at: Date.now(), projects: alive };
    return raw
      ? alive
      : dropStaleRemote(alive, this.remote?.listing ?? new Map());
  }
  private async localScan() {
    const ttl = this.o.scanTtlMs ?? 600_000;
    if (this.scan && Date.now() - this.scan.at < ttl) return this.scan.projects;
    if (!this.scanning)
      this.scanning = scanLocalProjects(this.o.roots)
        .then((projects) => {
          this.scan = { at: Date.now(), projects };
          return projects;
        })
        .finally(() => {
          this.scanning = undefined;
        });
    return this.scanning;
  }
  async warm() {
    await Promise.allSettled([
      this.history(),
      this.localScan(),
      this.remoteProjects(),
    ]);
  }
  async all() {
    return dedupeProjects([
      await this.history(),
      await this.localScan(),
      (await this.remoteProjects())?.projects ?? [],
    ]);
  }
  async find(query: string, host?: string) {
    const fromHistory = matchProjects(await this.history(), query, host);
    if (fromHistory.matches.length) return fromHistory.matches;
    return matchProjects(await this.all(), query, host).matches;
  }
  async byKey(key: string) {
    return (await this.all()).find((project) => project.key === key);
  }
}
