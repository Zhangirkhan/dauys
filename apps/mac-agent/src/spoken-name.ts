const CYR_TO_LAT: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

const WORD_TO_NUM: Record<string, string> = {
  ноль: "0",
  zero: "0",
  один: "1",
  одна: "1",
  одно: "1",
  одного: "1",
  одному: "1",
  одним: "1",
  одну: "1",
  первый: "1",
  первая: "1",
  первое: "1",
  первому: "1",
  первым: "1",
  первую: "1",
  первого: "1",
  one: "1",
  first: "1",
  два: "2",
  две: "2",
  двух: "2",
  двум: "2",
  второй: "2",
  вторая: "2",
  второе: "2",
  вторую: "2",
  второго: "2",
  two: "2",
  second: "2",
  три: "3",
  трех: "3",
  трем: "3",
  третий: "3",
  третья: "3",
  третье: "3",
  третью: "3",
  третьего: "3",
  three: "3",
  third: "3",
  четыре: "4",
  четырех: "4",
  четвертый: "4",
  четвертая: "4",
  четвертое: "4",
  четвертую: "4",
  four: "4",
  fourth: "4",
  пять: "5",
  пяти: "5",
  пятый: "5",
  пятая: "5",
  пятое: "5",
  пятую: "5",
  five: "5",
  fifth: "5",
  шесть: "6",
  шести: "6",
  шестой: "6",
  шестая: "6",
  шестое: "6",
  шестую: "6",
  six: "6",
  sixth: "6",
  семь: "7",
  семи: "7",
  седьмой: "7",
  седьмая: "7",
  седьмое: "7",
  седьмую: "7",
  seven: "7",
  seventh: "7",
  восемь: "8",
  восьми: "8",
  восьмой: "8",
  восьмая: "8",
  восьмое: "8",
  восьмую: "8",
  eight: "8",
  eighth: "8",
  девять: "9",
  девяти: "9",
  девятый: "9",
  девятая: "9",
  девятое: "9",
  девятую: "9",
  nine: "9",
  ninth: "9",
  десять: "10",
  десяти: "10",
  десятый: "10",
  десятая: "10",
  десятое: "10",
  ten: "10",
  tenth: "10",
  одиннадцать: "11",
  eleven: "11",
  двенадцать: "12",
  twelve: "12",
  тринадцать: "13",
  четырнадцать: "14",
  пятнадцать: "15",
  шестнадцать: "16",
  семнадцать: "17",
  восемнадцать: "18",
  девятнадцать: "19",
  двадцать: "20",
  twenty: "20",
};

const NUM_TO_WORD: Record<string, string> = {
  "0": "ноль",
  "1": "один",
  "2": "два",
  "3": "три",
  "4": "четыре",
  "5": "пять",
  "6": "шесть",
  "7": "семь",
  "8": "восемь",
  "9": "девять",
  "10": "десять",
  "11": "одиннадцать",
  "12": "двенадцать",
};

const KIND_PREFIX =
  /^(?:папк\p{L}*|folder|каталог\p{L}*|директор\p{L}*|файл\p{L}*|file) /u;

export type NamedKind = "file" | "folder" | "any";
export type NamedPick =
  | { type: "open"; path: string }
  | { type: "choose"; paths: string[] }
  | { type: "none" };

export function normalizeSpokenName(s: string) {
  return s
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[_./\\-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b0+(\d+)\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const DIGRAPHS: Array<[RegExp, string]> = [
  [/дж/g, "j"],
  [/кс/g, "x"],
];

export function translitCyrillic(s: string) {
  let out = s;
  for (const [from, to] of DIGRAPHS) out = out.replace(from, to);
  return [...out].map((ch) => CYR_TO_LAT[ch] ?? ch).join("");
}

/** Spoken tech words that never survive transliteration. */
const TECH: Record<string, string> = {
  джипити: "gpt",
  гпт: "gpt",
  gpt: "gpt",
  джипиті: "gpt",
  эйай: "ai",
  аи: "ai",
  апи: "api",
  энерджи: "energy",
  енерджи: "energy",
  энержи: "energy",
  енержи: "energy",
  energy: "energy",
  плюс: "plus",
  plus: "plus",
  ватсап: "whatsapp",
  ватсапп: "whatsapp",
  вотсап: "whatsapp",
  вотсапп: "whatsapp",
  вацап: "whatsapp",
  вацапп: "whatsapp",
  whatsapp: "whatsapp",
  эскуэль: "sql",
  сиэсэс: "css",
  джаваскрипт: "js",
  джиэс: "js",
  айос: "ios",
  юай: "ui",
  юикс: "ux",
};

/**
 * Collapses latin spellings that sound the same in Russian, so `cascade`
 * and a transliterated `каскад` meet in the middle.
 */
export function phoneticLatin(s: string) {
  return s
    .replace(/sch/g, "sh")
    .replace(/ck/g, "k")
    .replace(/ph/g, "f")
    .replace(/th/g, "t")
    .replace(/qu/g, "kv")
    .replace(/x/g, "ks")
    .replace(/wh/g, "v")
    .replace(/w/g, "v")
    .replace(/c/g, "k")
    .replace(/y/g, "i")
    .replace(/([a-z])\1+/g, "$1")
    .replace(/e$/, "");
}

export function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return row[b.length];
}

function numberForToken(token: string) {
  if (!token) return undefined;
  if (WORD_TO_NUM[token]) return WORD_TO_NUM[token];
  if (token.length < 4) return undefined;
  for (const [word, num] of Object.entries(WORD_TO_NUM)) {
    if (word.length >= 4 && levenshtein(token, word) <= 1) return num;
  }
  return undefined;
}

export function expandSpokenNumbers(s: string) {
  return normalizeSpokenName(s)
    .split(" ")
    .filter(Boolean)
    .map((token) => numberForToken(token) ?? token)
    .join(" ");
}

function expandSpokenWords(s: string) {
  return normalizeSpokenName(s)
    .split(" ")
    .filter(Boolean)
    .map((token) => NUM_TO_WORD[token] ?? token)
    .join(" ");
}

function applyTechAliases(s: string) {
  return s
    .split(" ")
    .filter(Boolean)
    .map((token) => TECH[token] ?? token)
    .join(" ");
}

export function coreSpokenName(s: string) {
  const n = applyTechAliases(expandSpokenNumbers(s));
  const stripped = n.replace(KIND_PREFIX, "").trim();
  return stripped || n;
}

function compactName(s: string) {
  return coreSpokenName(s).replace(/\s+/g, "");
}

function kindPrefixes(kind: NamedKind) {
  if (kind === "folder") return ["папка", "folder"];
  if (kind === "file") return ["файл", "file"];
  return [];
}

export function spokenNameVariants(query: string, kind: NamedKind = "any") {
  const base = normalizeSpokenName(query);
  if (!base) return [];
  const numbered = expandSpokenNumbers(base);
  const words = expandSpokenWords(base);
  const variants = new Set<string>([base, numbered, words].filter(Boolean));
  for (const current of [...variants]) {
    const tech = applyTechAliases(current);
    if (tech) variants.add(tech);
    const latin = translitCyrillic(tech || current);
    if (latin !== current) variants.add(latin);
  }
  for (const prefix of kindPrefixes(kind)) {
    for (const current of [...variants]) {
      if (current === prefix || current.startsWith(prefix + " ")) continue;
      variants.add(prefix + " " + current);
    }
  }
  return [...variants];
}

export function escapeSpotlightValue(s: string) {
  return s.replace(/[\\"*?()]/g, " ").replace(/\s+/g, " ").trim();
}

function nameClause(value: string) {
  const v = escapeSpotlightValue(value);
  if (!v) return "";
  return `(kMDItemFSName == "*${v}*"cd || kMDItemDisplayName == "*${v}*"cd)`;
}

export function buildNamedSpotlightQuery(needle: string, kind: NamedKind) {
  const variants = spokenNameVariants(needle, kind);
  const clauses: string[] = [];
  const add = (clause: string) => {
    if (clause && !clauses.includes(clause)) clauses.push(clause);
  };
  for (const variant of variants) {
    const compact = variant.replace(/\s+/g, "");
    const tokens = variant.split(" ").filter(Boolean);
    if (compact.length >= 3) add(nameClause(variant));
    if (tokens.length >= 2)
      add(
        "(" +
          tokens
            .map((token) => {
              const v = escapeSpotlightValue(token);
              return v ? `kMDItemFSName == "*${v}*"cd` : "";
            })
            .filter(Boolean)
            .join(" && ") +
          ")",
      );
  }
  if (!clauses.length) {
    const n = escapeSpotlightValue(expandSpokenNumbers(needle) || needle);
    if (kind === "folder" && n)
      add(`(kMDItemFSName == "*папка*"cd && kMDItemFSName == "*${n}*"cd)`);
    else if (kind === "file" && n)
      add(`(kMDItemFSName == "*файл*"cd && kMDItemFSName == "*${n}*"cd)`);
    else if (n) add(nameClause(n));
  }
  return clauses.length ? "(" + clauses.slice(0, 10).join(" || ") + ")" : "";
}

function spokenForms(s: string) {
  const core = coreSpokenName(s);
  const tokens = core
    .split(" ")
    .filter(Boolean)
    .map((token) => TECH[token] ?? token);
  const compact = tokens.join("");
  const latin = translitCyrillic(compact);
  const latinTokens = tokens.map((token) => translitCyrillic(token));
  return {
    core,
    compact,
    latin,
    phonetic: phoneticLatin(latin),
    tokens,
    latinTokens,
    phoneticTokens: latinTokens.map((token) => phoneticLatin(token)),
  };
}

function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1000;
  const dist = levenshtein(a, b);
  const len = Math.max(a.length, b.length);
  if (len >= 4 && dist === 1) return 860;
  if (len >= 6 && dist === 2) return 760;
  if (len >= 10 && dist === 3) return 700;
  if (b.length >= 3 && a.startsWith(b)) return 520;
  if (b.length >= 4 && a.includes(b)) return 420;
  return 0;
}

/** Domain and infrastructure segments that never identify a project on their own. */
const GENERIC_SEGMENTS = new Set([
  "www",
  "com",
  "net",
  "org",
  "io",
  "dev",
  "app",
  "kz",
  "ru",
  "kg",
  "uz",
  "by",
  "ua",
  "biz",
  "info",
  "online",
  "site",
  "store",
  "shop",
  "tech",
  "cloud",
  "local",
  "esl",
  "var",
  "home",
  "users",
]);

/**
 * Scores a spoken query against a project-style label such as `cargo.esl.kz`,
 * where a single dotted segment is usually what the user says out loud.
 */
export function scoreSpokenLabel(label: string, needle: string) {
  const L = spokenForms(label);
  const N = spokenForms(needle);
  if (!L.compact || !N.compact) return 0;
  let best = 0;
  for (const left of [L.compact, L.latin, L.phonetic])
    for (const right of [N.compact, N.latin, N.phonetic])
      best = Math.max(best, similarity(left, right));
  for (const [index, token] of L.tokens.entries()) {
    const leading = index === 0;
    if (token.length <= 2 || GENERIC_SEGMENTS.has(L.latinTokens[index]))
      continue;
    for (const left of [
      token,
      L.latinTokens[index],
      L.phoneticTokens[index],
    ])
      for (const right of [N.compact, N.latin, N.phonetic]) {
        const score = similarity(left, right);
        if (score)
          best = Math.max(best, Math.round(score * 0.82) - (leading ? 0 : 40));
      }
  }
  return best;
}

export function scoreNamedPath(
  path: string,
  needle: string,
  _kind: NamedKind = "any",
) {
  const { basename, extname } = requireName(path);
  const name = basename;
  const stem = extname ? basename.slice(0, -extname.length) : basename;
  const needleNorm = expandSpokenNumbers(needle);
  const nameNorm = expandSpokenNumbers(name);
  const stemNorm = expandSpokenNumbers(stem);
  const needleCore = coreSpokenName(needleNorm);
  const nameCore = coreSpokenName(nameNorm);
  const stemCore = coreSpokenName(stemNorm);
  const needleC = compactName(needleCore);
  const nameC = compactName(nameCore);
  const stemC = compactName(stemCore);
  const shortNum = /^\d{1,2}$/.test(needleC);
  const needleLat = translitCyrillic(needleCore);
  let s = 0;
  if (nameNorm === needleNorm || stemNorm === needleNorm) s += 1000;
  else if (nameCore === needleCore || stemCore === needleCore) s += 960;
  else if (nameC === needleC || stemC === needleC) s += 920;
  else if (
    needleLat !== needleCore &&
    (stemNorm === needleLat ||
      nameNorm === needleLat ||
      compactName(stemNorm) === compactName(needleLat))
  )
    s += 900;
  else if (
    !shortNum &&
    (nameNorm.startsWith(needleNorm) ||
      stemNorm.startsWith(needleNorm) ||
      nameCore.startsWith(needleCore) ||
      stemCore.startsWith(needleCore))
  )
    s += 300;
  else if (
    !shortNum &&
    (nameNorm.includes(needleNorm) ||
      stemNorm.includes(needleNorm) ||
      nameCore.includes(needleCore) ||
      stemCore.includes(needleCore))
  )
    s += 80;
  const tokens = needleCore.split(" ").filter(Boolean);
  const nameTok = new Set(
    (nameNorm + " " + nameCore + " " + stemNorm)
      .split(" ")
      .filter(Boolean),
  );
  if (tokens.length && tokens.every((token) => nameTok.has(token))) s += 160;
  const dist = Math.min(
    levenshtein(needleC, nameC),
    levenshtein(needleC, stemC),
    levenshtein(needleC, compactName(nameNorm)),
    needleLat === needleCore
      ? 99
      : levenshtein(compactName(needleLat), stemC),
  );
  if (!shortNum && needleC.length >= 4 && dist <= 2)
    s += Math.max(0, 200 - dist * 70);
  s -= path.split("/").filter(Boolean).length * 8;
  if (s > 0) {
    if (
      /\/(Desktop|Documents|Downloads|Developer|Movies|Music|Pictures)(\/|$)/i.test(
        path,
      )
    )
      s += 120;
  }
  if (/\/(Library|node_modules|\.git|\.venv|dist)\//.test(path)) s -= 600;
  return s;
}

function requireName(path: string) {
  const slash = path.lastIndexOf("/");
  const basename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = basename.lastIndexOf(".");
  const extname = dot > 0 ? basename.slice(dot) : "";
  return { basename, extname };
}

export function rankNamedMatches(
  paths: string[],
  needle: string,
  kind: NamedKind = "any",
) {
  return [...new Set(paths)].sort(
    (a, b) =>
      scoreNamedPath(b, needle, kind) - scoreNamedPath(a, needle, kind) ||
      a.length - b.length,
  );
}

export function pickNamedMatch(
  paths: string[],
  needle: string,
  kind: NamedKind = "any",
): NamedPick {
  const scored = [...new Set(paths)]
    .map((path) => ({ path, score: scoreNamedPath(path, needle, kind) }))
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  const viable = scored.filter((item) => item.score >= 50);
  if (!viable.length) return { type: "none" };
  const best = viable[0];
  const close = viable
    .filter((item) => item.score >= best.score - 80)
    .slice(0, 5);
  if (
    close.length >= 2 &&
    close[1].score >= Math.max(120, best.score - 80)
  )
    return { type: "choose", paths: close.map((item) => item.path) };
  return { type: "open", path: best.path };
}
