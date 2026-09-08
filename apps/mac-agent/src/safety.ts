import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep, extname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  envelopeSchema,
  requiresConfirmation,
  type Envelope,
} from "../../../packages/shared/src/index.js";
export const documentExtensions = new Set([
  ".pdf",
  ".ppt",
  ".pptx",
  ".key",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".numbers",
  ".pages",
  ".txt",
  ".md",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".heic",
  ".gif",
  ".mp3",
  ".m4a",
  ".mp4",
  ".mov",
]);
export function isWithin(path: string, root: string) {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))
  );
}
export async function guardPath(
  path: string,
  roots: string[],
  kind: "file" | "folder" | "project" = "file",
) {
  if (!isAbsolute(path) || /[\x00-\x1f]/.test(path))
    throw new Error("Небезопасный путь");
  const actual = await realpath(path);
  const allowed = await Promise.all(
    roots
      .filter((r) => r !== "/")
      .map(async (r) => {
        try {
          return await realpath(r);
        } catch {
          return null;
        }
      }),
  );
  if (!allowed.some((r) => r && isWithin(actual, r)))
    throw new Error(
      "Путь вне ALLOWED_DIRECTORIES. Добавьте нужный каталог локально в .env агента.",
    );
  if (
    actual
      .split(sep)
      .some((p) => p.startsWith(".") || /\.(app|workflow|scptd)$/i.test(p))
  )
    throw new Error(
      "Скрытые файлы, пакеты приложений и автоматизации запрещены.",
    );
  const info = await stat(actual);
  if (
    kind === "file" &&
    !info.isFile()
  )
    throw new Error("Ожидался файл");
  if (kind !== "file" && !info.isDirectory())
    throw new Error("Ожидалась папка");
  return actual;
}
export class ExecutionLedger {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS executed(id TEXT PRIMARY KEY,expiresAt INTEGER)",
    );
  }
  claim(raw: unknown): Envelope {
    const e = envelopeSchema.parse(raw);
    const now = Date.now();
    if (e.expiresAt <= now || e.createdAt > now + 5000)
      throw new Error("Команда истекла или часы устройств расходятся");
    if (requiresConfirmation(e.command) && !e.confirmed)
      throw new Error("Для действия требуется подтверждение на телефоне");
    try {
      this.db
        .prepare("INSERT INTO executed VALUES (?,?)")
        .run(e.id, e.expiresAt);
    } catch {
      throw new Error("Повторное выполнение command ID запрещено");
    }
    this.db
      .prepare("DELETE FROM executed WHERE expiresAt<?")
      .run(now - 86400000);
    return e;
  }
  close() {
    this.db.close();
  }
}
