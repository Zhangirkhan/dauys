import { homedir } from "node:os";
import { join } from "node:path";

const normalizeName = (s: string) =>
  s
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function knownFolderPathWindows(query: string): string | undefined {
  const n = normalizeName(query);
  if (!n) return undefined;
  const home = homedir();
  const folders: Array<[string[], string]> = [
    [
      ["downloads", "download", "загрузки", "загрузка", "загрузок"],
      join(home, "Downloads"),
    ],
    [
      ["documents", "document", "документы", "документов"],
      join(home, "Documents"),
    ],
    [
      ["desktop", "рабочий стол", "рабочего стола"],
      join(home, "Desktop"),
    ],
    [
      ["pictures", "изображения", "фотографии"],
      join(home, "Pictures"),
    ],
    [["music", "музыка"], join(home, "Music")],
    [["videos", "видео", "фильмы"], join(home, "Videos")],
  ];
  for (const [names, path] of folders)
    if (names.some((name) => n === name || n.startsWith(name))) return path;
  return undefined;
}
