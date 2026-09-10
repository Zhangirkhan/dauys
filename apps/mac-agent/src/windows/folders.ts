import { homedir } from "node:os";
import { join } from "node:path";

const normalizeName = (s: string) =>
  s
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export type KnownFolderId =
  | "downloads"
  | "documents"
  | "desktop"
  | "pictures"
  | "music"
  | "videos";

export function knownFolderIdWindows(query: string): KnownFolderId | undefined {
  const n = normalizeName(query);
  if (!n) return undefined;
  const names: Array<[KnownFolderId, string[]]> = [
    ["downloads", ["downloads", "download", "загрузки", "загрузка", "загрузок"]],
    ["documents", ["documents", "document", "документы", "документов"]],
    ["desktop", ["desktop", "рабочий стол", "рабочего стола"]],
    ["pictures", ["pictures", "изображения", "фотографии"]],
    ["music", ["music", "музыка"]],
    ["videos", ["videos", "видео", "фильмы"]],
  ];
  return names.find(([, aliases]) =>
    aliases.some((name) => n === name || n.startsWith(name)),
  )?.[0];
}

export function knownFolderPathWindows(query: string): string | undefined {
  const id = knownFolderIdWindows(query);
  if (!id) return undefined;
  const home = homedir();
  const folderNames: Record<KnownFolderId, string> = {
    downloads: "Downloads",
    documents: "Documents",
    desktop: "Desktop",
    pictures: "Pictures",
    music: "Music",
    videos: "Videos",
  };
  return join(home, folderNames[id]);
}
