import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  allowedSshHosts,
  dedupeProjects,
  dropStaleRemote,
  guardRemoteUri,
  listRemoteProjects,
  matchProjects,
  parseFolderUri,
  projectKey,
  remoteProjectsFrom,
  remoteRootsFromHistory,
  scanLocalProjects,
  type CursorProject,
} from "../apps/mac-agent/src/cursor-projects.js";

const remote = (host: string, path: string) =>
  "vscode-remote://ssh-remote%2B" +
  Buffer.from(JSON.stringify({ hostName: host }), "utf8").toString("hex") +
  path;

const project = (uri: string, recency = 0) => {
  const parsed = parseFolderUri(uri);
  if (!parsed) throw new Error("не разобрал " + uri);
  return { ...parsed, recency };
};

describe("cursor project index", () => {
  it("decodes a local folder uri with percent escapes", () => {
    expect(parseFolderUri("file:///Users/me/assistance%20")).toMatchObject({
      name: "assistance ",
      path: "/Users/me/assistance ",
      local: true,
    });
  });

  it("decodes an ssh-remote authority carrying a hex json host", () => {
    expect(parseFolderUri(remote("projects.100k.kz", "/var/www/dauys.esl.kz"))).
      toMatchObject({
        name: "dauys.esl.kz",
        path: "/var/www/dauys.esl.kz",
        host: "projects.100k.kz",
        local: false,
      });
  });

  it("accepts a plain (non hex) ssh authority", () => {
    expect(
      parseFolderUri("vscode-remote://ssh-remote%2Bermart/home/debian/ermart"),
    ).toMatchObject({ host: "ermart", name: "ermart" });
  });

  it("ignores unsupported schemes and malformed uris", () => {
    expect(parseFolderUri("untitled:Untitled-1")).toBeUndefined();
    expect(parseFolderUri("vscode-remote://wsl%2Bubuntu/home")).toBeUndefined();
    expect(parseFolderUri("nonsense")).toBeUndefined();
  });

  it("keys projects stably by uri", () => {
    const uri = remote("ermart", "/var/www/html");
    expect(projectKey(uri)).toBe(projectKey(uri));
    expect(projectKey(uri)).toMatch(/^[a-f0-9]{12}$/);
    expect(projectKey(uri)).not.toBe(projectKey(uri + "x"));
  });

  it("finds a remote project from a russian pronunciation", () => {
    const projects = [
      project(remote("projects.100k.kz", "/var/www/cargo.esl.kz")),
      project(remote("projects.100k.kz", "/var/www/energygpt")),
      project("file:///Users/me/developer/betgpt"),
    ];
    expect(matchProjects(projects, "карго").matches[0]?.name).toBe(
      "cargo.esl.kz",
    );
    expect(matchProjects(projects, "бетгпт").matches[0]?.name).toBe("betgpt");
    expect(matchProjects(projects, "дауыс").matches).toHaveLength(0);
  });

  it("bridges russian pronunciation of latin project names", () => {
    const projects = [
      project(remote("projects.100k.kz", "/var/www/cascade.kz")),
      project(remote("projects.100k.kz", "/var/www/energygpt")),
      project("file:///Users/me/aimarketplace"),
    ];
    expect(matchProjects(projects, "каскад").matches[0]?.name).toBe(
      "cascade.kz",
    );
    expect(matchProjects(projects, "энерджи джипити").matches[0]?.name).toBe(
      "energygpt",
    );
    expect(matchProjects(projects, "аимаркетплейс").matches[0]?.name).toBe(
      "aimarketplace",
    );
  });

  it("asks when the same project name exists on two hosts", () => {
    const projects = [
      project(remote("projects.100k.kz", "/var/www/chatagents.esl.kz")),
      project(remote("server.100k.kz", "/var/www/chatagents.esl.kz"), 1),
    ];
    expect(matchProjects(projects, "чатагентс").matches).toHaveLength(2);
  });

  it("narrows an ambiguous project by the spoken host", () => {
    const projects = [
      project(remote("projects.100k.kz", "/var/www/chatagents.esl.kz")),
      project(remote("server.100k.kz", "/var/www/chatagents.esl.kz"), 1),
    ];
    const picked = matchProjects(projects, "чатагентс", "сервер");
    expect(picked.matches).toHaveLength(1);
    expect(picked.matches[0].host).toBe("server.100k.kz");
  });

  it("prefers the most recent entry among equal names", () => {
    const projects = [
      project("file:///Users/me/old/otp", 7),
      project("file:///Users/me/new/otp", 1),
    ];
    expect(matchProjects(projects, "отп").matches).toHaveLength(2);
    expect(matchProjects(projects, "отп").matches[0].path).toBe(
      "/Users/me/new/otp",
    );
  });

  it("keeps the freshest duplicate when merging sources", () => {
    const uri = "file:///Users/me/developer/betgpt";
    const merged = dedupeProjects([
      [project(uri, 9)],
      [project(uri, 2)],
    ]) as CursorProject[];
    expect(merged).toHaveLength(1);
    expect(merged[0].recency).toBe(2);
  });

  it("reads ssh hosts from a config and rejects wildcards", () => {
    const hosts = allowedSshHosts(
      "Host projects.100k.kz\n  User root\nHost *\n  AddKeysToAgent yes\nHost a b\n",
      "extra.example.com",
    );
    expect([...hosts].sort()).toEqual([
      "a",
      "b",
      "extra.example.com",
      "projects.100k.kz",
    ]);
  });

  it("only allows ssh-remote uris on known hosts", () => {
    const hosts = new Set(["projects.100k.kz"]);
    expect(
      guardRemoteUri(remote("projects.100k.kz", "/var/www/x"), hosts).host,
    ).toBe("projects.100k.kz");
    expect(() => guardRemoteUri(remote("evil.example", "/etc"), hosts)).toThrow(
      /ssh\/config/,
    );
    expect(() => guardRemoteUri("file:///etc/passwd", hosts)).toThrow(/SSH/);
    expect(() =>
      guardRemoteUri(
        'vscode-remote://ssh-remote%2Bermart/tmp/"; rm -rf /',
        new Set(["ermart"]),
      ),
    ).toThrow(/Небезопасный/);
  });

  it("derives remote listing roots and skips system directories", () => {
    const roots = remoteRootsFromHistory([
      project(remote("projects.100k.kz", "/var/www/cargo.esl.kz")),
      project(remote("projects.100k.kz", "/var/www")),
      project(remote("server.100k.kz", "/root/.ssh")),
      project(remote("ermart", "/home/debian/ermart")),
      project("file:///Users/me/betgpt"),
    ]);
    expect([...(roots.get("projects.100k.kz") ?? [])]).toEqual(["/var/www"]);
    expect([...(roots.get("ermart") ?? [])]).toEqual(["/home/debian"]);
    expect(roots.has("server.100k.kz")).toBe(false);
  });

  it("lists remote folders and refuses unsafe directories or hosts", async () => {
    const calls: string[][] = [];
    const exec = async (_file: string, args: string[]) => {
      calls.push(args);
      return "/var/www/a\n/var/www/b\n\n";
    };
    const listed = await listRemoteProjects(
      "projects.100k.kz",
      ["/var/www", '/var/www"; rm -rf /'],
      exec,
    );
    expect(listed.paths).toEqual(["/var/www/a", "/var/www/b"]);
    expect(listed.listed).toEqual(["/var/www"]);
    expect(calls[0].at(-1)).not.toContain("rm -rf");
    expect(
      await listRemoteProjects("host; whoami", ["/var/www"], exec),
    ).toEqual({ paths: [], listed: [] });
    expect(calls).toHaveLength(1);
  });

  it("builds openable projects out of a remote listing", () => {
    const [built] = remoteProjectsFrom("ermart", ["/var/www/site one"]);
    expect(built).toMatchObject({
      name: "site one",
      host: "ermart",
      local: false,
    });
    expect(parseFolderUri(built.uri)?.path).toBe("/var/www/site one");
  });

  it("drops history folders the server no longer has", () => {
    const alive = project(remote("projects.100k.kz", "/var/www/dauys.esl.kz"));
    const gone = project(remote("projects.100k.kz", "/var/www/umon.esl.kz"));
    const elsewhere = project(remote("ermart", "/home/debian/ermart"));
    const listing = new Map([
      [
        "projects.100k.kz",
        {
          paths: new Set(["/var/www/dauys.esl.kz"]),
          listed: new Set(["/var/www"]),
        },
      ],
    ]);
    const kept = dropStaleRemote([alive, gone, elsewhere], listing);
    expect(kept.map((p) => p.name)).toEqual(["dauys.esl.kz", "ermart"]);
    expect(dropStaleRemote([alive, gone], new Map())).toHaveLength(2);
  });

  it("scans the disk for project folders and stops at the project root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "voice-projects-"));
    try {
      await mkdir(join(dir, "work/site/src"), { recursive: true });
      await writeFile(join(dir, "work/site/package.json"), "{}");
      await mkdir(join(dir, "work/site/node_modules/dep"), { recursive: true });
      await writeFile(join(dir, "work/site/node_modules/dep/package.json"), "{}");
      await mkdir(join(dir, "work/notes"), { recursive: true });
      const found = await scanLocalProjects([dir]);
      expect(found.map((p) => p.name)).toEqual(["site"]);
      expect(found[0].uri).toContain("file://");
      expect(found[0].local).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
