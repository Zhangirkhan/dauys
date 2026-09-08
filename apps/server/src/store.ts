import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes, randomUUID, randomInt } from "node:crypto";
import {
  registrySchema,
  type Registry,
  type Context,
  type CommandRecord,
} from "../../../packages/shared/src/index.js";
export type Device = {
  id: string;
  name: string;
  role: "client" | "agent";
  agentId: string;
  revoked: number;
  createdAt: number;
};
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT,role TEXT,agentId TEXT,tokenHash TEXT UNIQUE,revoked INTEGER DEFAULT 0,createdAt INTEGER);
 CREATE TABLE IF NOT EXISTS pairs(codeHash TEXT PRIMARY KEY,agentId TEXT,expiresAt INTEGER);
 CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,deviceId TEXT,agentId TEXT,createdAt INTEGER,record TEXT);
 CREATE TABLE IF NOT EXISTS contexts(agentId TEXT PRIMARY KEY,record TEXT);
 `);
  }
  createDevice(name: string, role: "client" | "agent", agentId?: string) {
    const id = randomUUID(),
      token = randomBytes(32).toString("base64url");
    const d: Device = {
      id,
      name,
      role,
      agentId: agentId ?? id,
      revoked: 0,
      createdAt: Date.now(),
    };
    this.db
      .prepare("INSERT INTO devices VALUES (?,?,?,?,?,0,?)")
      .run(id, name, role, d.agentId, hash(token), d.createdAt);
    return { ...d, token };
  }
  authenticate(token: string): Device | undefined {
    return this.db
      .prepare(
        "SELECT id,name,role,agentId,revoked,createdAt FROM devices WHERE tokenHash=? AND revoked=0",
      )
      .get(hash(token)) as Device | undefined;
  }
  devices(agentId: string) {
    return this.db
      .prepare(
        "SELECT id,name,role,agentId,revoked,createdAt FROM devices WHERE agentId=?",
      )
      .all(agentId) as Device[];
  }
  revoke(id: string) {
    this.db
      .prepare(
        "UPDATE devices SET revoked=1 WHERE id=? OR (agentId=? AND ? IN (SELECT id FROM devices WHERE role='agent'))",
      )
      .run(id, id, id);
  }
  pair(agentId: string) {
    const code = String(randomInt(10000000, 100000000));
    const expiresAt = Date.now() + 300000;
    this.db
      .prepare("DELETE FROM pairs WHERE agentId=? OR expiresAt<?")
      .run(agentId, Date.now());
    this.db
      .prepare("INSERT INTO pairs VALUES(?,?,?)")
      .run(hash(code), agentId, expiresAt);
    return { code, expiresAt };
  }
  completePair(code: string, name: string) {
    const p = this.db
      .prepare("DELETE FROM pairs WHERE codeHash=? RETURNING agentId,expiresAt")
      .get(hash(code)) as { agentId: string; expiresAt: number } | undefined;
    if (
      !p ||
      p.expiresAt < Date.now() ||
      !this.devices(p.agentId).some((d) => d.id === p.agentId && !d.revoked)
    )
      throw new Error(
        "Код неверен или истёк. Получите новый код в терминале агента.",
      );
    return this.createDevice(name, "client", p.agentId);
  }
  save(c: CommandRecord) {
    this.db
      .prepare(
        "INSERT INTO commands VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
      )
      .run(c.id, c.deviceId, c.agentId, c.createdAt, JSON.stringify(c));
  }
  command(id: string) {
    const row = this.db
      .prepare("SELECT record FROM commands WHERE id=?")
      .get(id) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as CommandRecord) : undefined;
  }
  history(agentId: string, limit = 30) {
    return (
      this.db
        .prepare(
          "SELECT record FROM commands WHERE agentId=? ORDER BY createdAt DESC LIMIT ?",
        )
        .all(agentId, limit) as { record: string }[]
    ).map((r) => JSON.parse(r.record) as CommandRecord);
  }
  pending() {
    return (
      this.db.prepare("SELECT record FROM commands").all() as {
        record: string;
      }[]
    )
      .map((r) => JSON.parse(r.record) as CommandRecord)
      .filter((c) => !["done", "error", "cancelled"].includes(c.status));
  }
  context(agentId: string): Context {
    const r = this.db
      .prepare("SELECT record FROM contexts WHERE agentId=?")
      .get(agentId) as { record: string } | undefined;
    return r ? JSON.parse(r.record) : { recent: [] };
  }
  saveContext(agentId: string, c: Context) {
    this.db
      .prepare(
        "INSERT INTO contexts VALUES(?,?) ON CONFLICT(agentId) DO UPDATE SET record=excluded.record",
      )
      .run(agentId, JSON.stringify(c));
  }
  close() {
    this.db.close();
  }
}
export class RegistryFile {
  constructor(public path: string) {
    try {
      this.get();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.set(
        registrySchema.parse(
          JSON.parse(readFileSync("config/registry.example.json", "utf8")),
        ),
      );
    }
  }
  get(): Registry {
    const configured = registrySchema.parse(
      JSON.parse(readFileSync(this.path, "utf8")),
    );
    const directories = [
      "/Applications",
      "/System/Applications",
      "/System/Applications/Utilities",
      join(homedir(), "Applications"),
      join(homedir(), "Desktop"),
    ];
    const known = new Set(
      configured.applications.map((app) => app.name.toLocaleLowerCase()),
    );
    for (const directory of directories) {
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
        const name = basename(entry.name, ".app");
        if (known.has(name.toLocaleLowerCase())) continue;
        const candidate = {
          id: "auto-" + createHash("sha256").update(name).digest("hex").slice(0, 12),
          name,
          aliases: [name.toLocaleLowerCase()],
          path: join(directory, entry.name),
        };
        if (
          name.length <= 80 &&
          /^[\p{L}\p{N} ._+-]+$/u.test(name) &&
          !name.includes("..")
        ) {
          configured.applications.push(candidate);
          known.add(name.toLocaleLowerCase());
        }
      }
    }
    return configured;
  }
  set(value: Registry) {
    const v = registrySchema.parse(value);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path + ".tmp", JSON.stringify(v, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(this.path + ".tmp", this.path);
    return v;
  }
}
