import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { scoreNamedPath, scoreSpokenLabel } from "./spoken-name.js";

export type InstalledApp = {
  name: string;
  path: string;
  aliases: string[];
};

const SKIP =
  /helper|uninstaller|updater|\.appex$|install macos|migration assistant|boot camp|folder actions setup|audio midi setup|bluetooth file exchange|colorsync|console|disk utility|grapher|image capture|script editor|automator|terminal|iterm|warp|prompt|alacritty|kitty/i;

const ALIASES: Record<string, string[]> = {
  calculator: ["калькулятор", "кальк"],
  calendar: ["календарь", "календар"],
  clock: ["часы"],
  contacts: ["контакты"],
  dictionary: ["словарь", "словари"],
  facetime: ["фейстайм", "face time"],
  findmy: ["локатор", "find my"],
  fontbook: ["шрифты"],
  freeform: ["фриформ"],
  home: ["дом"],
  mail: ["почта", "мейл"],
  maps: ["карты"],
  messages: ["сообщения", "именедж", "имessage"],
  music: ["музыка", "эпл музыка", "apple music"],
  news: ["новости"],
  notes: ["заметки", "заметка", "нотас"],
  numbers: ["намберс", "таблица эпл"],
  pages: ["пейджес", "пейджс"],
  keynote: ["кейнот", "кейноут"],
  photos: ["фото", "фотографии", "эпл фото"],
  podcasts: ["подкасты"],
  preview: ["просмотр", "превью"],
  reminders: ["напоминания"],
  safari: ["сафари"],
  shortcuts: ["команды", "шорткаты"],
  stickies: ["стикеры"],
  stocks: ["акции"],
  "system settings": ["настройки", "системные настройки"],
  "system preferences": ["настройки", "системные настройки"],
  textedit: ["текстовый редактор", "текстэдит"],
  tv: ["тв", "эпл тв"],
  voiceover: ["voiceover"],
  weather: ["погода"],
  "app store": ["аппстор", "апп стор", "магазин"],
  books: ["книги", "эпл книги"],
  chess: ["шахматы"],
  "microsoft excel": [
    "эксель",
    "эксел",
    "аксель",
    "акцел",
    "excel",
    "майкрософт эксель",
    "майкрософт эксел",
  ],
  "microsoft word": ["ворд", "ворде", "word", "майкрософт ворд"],
  "microsoft powerpoint": [
    "пауэрпоинт",
    "powerpoint",
    "презентации майкрософт",
  ],
  "microsoft teams": ["тимс", "teams"],
  "google chrome": ["хром", "chrome"],
  telegram: ["телеграм", "телега", "тг"],
  whatsapp: [
    "ватсап",
    "ватсапп",
    "вотсап",
    "вотсапп",
    "вацап",
    "вацапп",
    "whats app",
  ],
  discord: ["дискорд"],
  slack: ["слак"],
  zoom: ["зум"],
  spotify: ["спотифай"],
  figma: ["фигма"],
  notion: ["ноушен", "ноушн"],
  obsidian: ["обсидиан"],
};

function key(name: string) {
  return name
    .toLocaleLowerCase("en")
    .replace(/\.app$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isBlockedApp(name: string) {
  return SKIP.test(name.replace(/\.app$/i, ""));
}

export function scoreInstalledApp(app: InstalledApp, query: string) {
  let best = Math.max(
    scoreNamedPath(app.path, query),
    scoreSpokenLabel(app.name, query),
  );
  for (const alias of app.aliases)
    best = Math.max(
      best,
      scoreSpokenLabel(alias, query),
      scoreNamedPath("/Applications/" + alias + ".app", query),
    );
  return best;
}

export function pickInstalledApp(
  apps: InstalledApp[],
  query: string,
):
  | { type: "open"; app: InstalledApp }
  | { type: "choose"; apps: InstalledApp[] }
  | { type: "none" } {
  const needle = query
    .replace(/^(?:приложение|программу|программу|прога|прогу)\s+/u, "")
    .trim();
  if (!needle) return { type: "none" };
  const scored = apps
    .filter((app) => !isBlockedApp(app.name))
    .map((app) => ({ app, score: scoreInstalledApp(app, needle) }))
    .filter((item) => item.score >= 80)
    .sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name));
  if (!scored.length) return { type: "none" };
  const best = scored[0];
  const close = scored
    .filter((item) => item.score >= best.score - 80)
    .slice(0, 5);
  if (close.length >= 2 && close[1].score >= Math.max(160, best.score - 80))
    return { type: "choose", apps: close.map((item) => item.app) };
  return { type: "open", app: best.app };
}

async function appsIn(dir: string, depth = 0): Promise<InstalledApp[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: InstalledApp[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.name.endsWith(".app")) {
      const name = basename(entry.name, ".app");
      if (!name || isBlockedApp(name)) continue;
      found.push({
        name,
        path,
        aliases: ALIASES[key(name)] ?? [],
      });
      continue;
    }
    if (depth < 2 && !entry.name.startsWith("."))
      found.push(...(await appsIn(path, depth + 1)));
  }
  return found;
}

const ROOTS = [
  "/Applications",
  "/System/Applications",
  "/System/Applications/Utilities",
  "/System/Cryptexes/App/System/Applications",
  join(homedir(), "Applications"),
  join(homedir(), "Desktop"),
];

export class InstalledAppIndex {
  private cache: InstalledApp[] = [];
  private loadedAt = 0;
  constructor(private roots = ROOTS) {}
  async list() {
    if (this.cache.length && Date.now() - this.loadedAt < 60_000)
      return this.cache;
    const found = new Map<string, InstalledApp>();
    for (const root of this.roots)
      for (const app of await appsIn(root)) {
        const k = app.path.toLowerCase();
        if (!found.has(k)) found.set(k, app);
      }
    this.cache = [...found.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    this.loadedAt = Date.now();
    return this.cache;
  }
  warm() {
    return this.list().then(() => undefined);
  }
  async resolve(query: string, extras: InstalledApp[] = []) {
    const installed = await this.list();
    const byPath = new Map(installed.map((app) => [app.path, app]));
    for (const app of extras)
      if (!byPath.has(app.path)) byPath.set(app.path, app);
    return pickInstalledApp([...byPath.values()], query);
  }
}
