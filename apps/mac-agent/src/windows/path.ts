import { realpath, stat, lstat } from "node:fs/promises";
import { win32 } from "node:path";

const executableExt =
  /\.(exe|bat|cmd|com|msi|msp|scr|ps1|vbs|vbe|js|jse|wsf|wsh|msc|jar|lnk|url|reg|inf|cpl)$/i;

/** Syntax-only checks before touching the filesystem. */
export function assertWindowsPathSyntax(path: string) {
  if (!path || /[\x00-\x1f]/.test(path))
    throw new Error("Небезопасный путь");
  if (
    path.startsWith("\\\\") ||
    path.startsWith("//") ||
    /^[\\/]{2}/.test(path) ||
    /^\\\\[.?]\\/i.test(path) ||
    /^\/\/[.?]\//i.test(path)
  )
    throw new Error(
      "UNC, device path и сетевые пути запрещены. Разрешите только явной локальной настройкой.",
    );
  if (/^[A-Za-z]:[^\\/]/.test(path))
    throw new Error("Drive-relative пути вроде C:folder запрещены");
  if (!/^[A-Za-z]:[\\/]/.test(path))
    throw new Error("Нужен абсолютный путь Windows с буквой диска");
  if (path.slice(2).includes(":"))
    throw new Error("Alternate Data Streams запрещены");
  if (path.includes("\0")) throw new Error("Небезопасный путь");
}

export function normalizeWindowsPath(path: string) {
  return win32.normalize(path).replace(/\//g, "\\");
}

/** Component-boundary containment, case-insensitive (Windows). */
export function isWithinWindows(candidate: string, root: string) {
  const c = normalizeWindowsPath(candidate).toLowerCase();
  const r = normalizeWindowsPath(root).toLowerCase();
  if (c === r) return true;
  const prefix = r.endsWith("\\") ? r : r + "\\";
  return c.startsWith(prefix);
}

export async function guardWindowsPath(
  path: string,
  roots: string[],
  kind: "file" | "folder" | "project" = "file",
  options: { allowUnc?: boolean } = {},
) {
  if (options.allowUnc && (path.startsWith("\\\\") || path.startsWith("//"))) {
    // Explicit opt-in only; still reject device paths and ADS.
    if (/^\\\\[.?]\\/i.test(path) || path.slice(2).includes(":"))
      throw new Error("Недопустимый сетевой путь");
  } else {
    assertWindowsPathSyntax(path);
  }
  if (!win32.isAbsolute(normalizeWindowsPath(path)) && !options.allowUnc)
    throw new Error("Небезопасный путь");

  let actual: string;
  try {
    actual = normalizeWindowsPath(await realpath(path));
  } catch {
    throw new Error("Путь не существует или недоступен");
  }

  // Detect junction/symlink escape: if the path itself is a reparse point
  // whose target left the allowed root, realpath already moved us — check roots.
  try {
    const link = await lstat(path);
    if (link.isSymbolicLink() || (link as { isJunction?: () => boolean }).isJunction?.()) {
      // realpath target must still be inside roots
    }
  } catch {
    /* ignore */
  }

  const allowed: string[] = [];
  for (const root of roots) {
    if (!root || root === "/" || /^[A-Za-z]:\\?$/.test(root)) continue;
    try {
      assertWindowsPathSyntax(root);
      allowed.push(normalizeWindowsPath(await realpath(root)));
    } catch {
      continue;
    }
  }
  if (!allowed.some((root) => isWithinWindows(actual, root)))
    throw new Error(
      "Путь вне ALLOWED_DIRECTORIES. Добавьте нужный каталог локально в .env агента.",
    );

  const parts = actual.split(/[\\/]/).filter(Boolean);
  if (
    parts.some(
      (part, i) =>
        (i > 0 && part.startsWith(".")) || executableExt.test(part),
    )
  )
    throw new Error(
      "Скрытые файлы, исполняемые и ярлыки запрещены в открываемых путях.",
    );

  const info = await stat(actual);
  if (kind === "file" && !info.isFile()) throw new Error("Ожидался файл");
  if (kind !== "file" && !info.isDirectory())
    throw new Error("Ожидалась папка");
  return actual;
}
