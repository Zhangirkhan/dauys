import { lstat, realpath, access, constants } from "node:fs/promises";
import { win32, extname, basename } from "node:path";
import { isSafeAbsolutePath } from "../../../../packages/shared/src/index.js";
import {
  assertWindowsPathSyntax,
  normalizeWindowsPath,
} from "./path.js";

const SAFE_EXE = /^\.exe$/i;
const DANGEROUS_ARGS =
  /(?:^|[\s"'])(?:-Command|-EncodedCommand|-File|\/c|\/k|cmd\.exe|powershell|pwsh|mshta|wscript|cscript|bitsadmin|certutil|reg\.exe|rundll32)(?:$|[\s"'])/i;

/** Trusted system launch targets — never accept remote/user-defined URIs here. */
export const TRUSTED_SYSTEM_TARGETS = {
  settings: {
    id: "settings",
    name: "Параметры",
    aliases: ["настройки", "параметры", "settings", "windows settings"],
    launch: "ms-settings:",
  },
  explorer: {
    id: "explorer",
    name: "Проводник",
    aliases: ["проводник", "файлы", "explorer", "file explorer"],
    launch: "explorer.exe",
  },
} as const;

export type TrustedSystemId = keyof typeof TRUSTED_SYSTEM_TARGETS;

export function isTrustedSystemId(id: string): id is TrustedSystemId {
  return Object.prototype.hasOwnProperty.call(TRUSTED_SYSTEM_TARGETS, id);
}

/**
 * Validate a candidate Windows executable for local trust mapping.
 * Rejects UNC, ADS, non-.exe, missing files, reparse points, and odd args.
 */
export async function validateWindowsExecutable(
  rawPath: string,
  args: string[] = [],
): Promise<string> {
  if (!isSafeAbsolutePath(rawPath))
    throw new Error("Нужен локальный абсолютный путь к .exe");
  assertWindowsPathSyntax(rawPath);
  const normalized = normalizeWindowsPath(rawPath);
  if (!SAFE_EXE.test(extname(normalized)))
    throw new Error("Допускаются только файлы .exe");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(basename(normalized)))
    throw new Error("Запрещённое имя устройства Windows");

  for (const a of args) {
    if (a.length > 2048) throw new Error("Слишком длинный аргумент");
    if (/[\x00-\x1f]/.test(a)) throw new Error("Недопустимый аргумент");
    if (DANGEROUS_ARGS.test(a))
      throw new Error("Опасные аргументы запуска запрещены");
  }

  let linkInfo;
  try {
    linkInfo = await lstat(normalized);
  } catch {
    throw new Error("Файл не найден: " + normalized);
  }
  if (linkInfo.isSymbolicLink())
    throw new Error("Symlink/junction для executable запрещены");
  const maybeJunction = linkInfo as unknown as { isJunction?: () => boolean };
  if (typeof maybeJunction.isJunction === "function" && maybeJunction.isJunction())
    throw new Error("Junction для executable запрещён");
  if (!linkInfo.isFile()) throw new Error("Путь не является файлом");

  let resolved: string;
  try {
    resolved = normalizeWindowsPath(await realpath(normalized));
  } catch {
    throw new Error("Не удалось разрешить путь executable");
  }
  if (resolved.toLowerCase() !== normalized.toLowerCase()) {
    // realpath changed path — likely reparse; reject
    throw new Error("Путь executable указывает на другую цель (reparse)");
  }
  if (!SAFE_EXE.test(extname(resolved)))
    throw new Error("После разрешения путь должен оставаться .exe");
  try {
    await access(resolved, constants.R_OK);
  } catch {
    throw new Error("Executable недоступен для чтения");
  }
  return resolved;
}

/** Reject Start Menu .lnk that point to URL / script / network. */
export function isUnsafeShortcutTarget(target: string, args = ""): boolean {
  const t = target.trim();
  if (!t) return true;
  if (/^(https?:|file:|ms-msdt:|search-ms:|javascript:)/i.test(t)) return true;
  if (t.startsWith("\\\\") || t.startsWith("//")) return true;
  if (/\.(lnk|url|bat|cmd|ps1|vbs|js|wsf|msc|scr)$/i.test(t)) return true;
  const base = win32.basename(t).toLowerCase();
  if (
    /^(cmd|powershell|pwsh|wscript|cscript|mshta|bitsadmin|certutil|reg|rundll32|msiexec)\.exe$/.test(
      base,
    )
  )
    return true;
  if (base === "explorer.exe" && args.trim()) return true;
  if (!/\.exe$/i.test(t)) return true;
  if (args && DANGEROUS_ARGS.test(args)) return true;
  return false;
}
