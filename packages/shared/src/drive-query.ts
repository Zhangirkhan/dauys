const DRIVE_HINT =
  /(?:^| )(?:на|с|со|из|в) (?:диске|диска|драйве|драйва|облаке|облака)(?: |$)|диско|с диск|на диск|drive esl|драйв(?: есл)?|корпоративн\p{L}* диск|(?<!\p{L})диск(?!\p{L})|файлов\p{L}* облак/u;

const FIND =
  /(?:найди|найти|открой|открыть|открою|откроем|откройте|открость|подкрой|покажи|вытащи|вытяну|вытащу|скачай|скачать|принеси|дай)(?:те)? /u;

const TYPES: Array<[RegExp, string]> = [
  [/(?<!\p{L})(?:пдф|pdf)(?!\p{L})/u, "тип:pdf"],
  [/(?<!\p{L})(?:презентац\p{L}*|pptx?|keynote)(?!\p{L})/u, "тип:презентация"],
  [/(?<!\p{L})(?:таблиц\p{L}*|эксел\p{L}*|excel|xlsx?)(?!\p{L})/u, "тип:таблица"],
  [/(?<!\p{L})(?:ворд|word|документ\p{L}*|docx?)(?!\p{L})/u, "тип:документ"],
  [/(?<!\p{L})(?:картинк\p{L}*|фото\p{L}*|изображен\p{L}*|скрин\p{L}*)(?!\p{L})/u, "тип:фото"],
  [/(?<!\p{L})(?:видео|ролик)(?!\p{L})/u, "тип:видео"],
  [/(?<!\p{L})(?:архив\p{L}*|зип|zip)(?!\p{L})/u, "тип:архив"],
  [/(?<!\p{L})(?:папк\p{L}*|каталог\p{L}*)(?!\p{L})/u, "тип:папка"],
];

const DATES: Array<[RegExp, string]> = [
  [/(?<!\p{L})(?:сегодня|за сегодня)(?!\p{L})/u, "after:1d"],
  [/(?<!\p{L})вчера(?!\p{L})/u, "after:2d"],
  [/(?<!\p{L})(?:на этой неделе|за неделю|за 7 дней)(?!\p{L})/u, "after:7d"],
  [/(?<!\p{L})(?:в этом месяце|за месяц)(?!\p{L})/u, "after:30d"],
];

const LAT_TO_CYR: Record<string, string> = {
  a: "а",
  b: "б",
  c: "к",
  d: "д",
  e: "е",
  f: "ф",
  g: "г",
  h: "х",
  i: "и",
  j: "дж",
  k: "к",
  l: "л",
  m: "м",
  n: "н",
  o: "о",
  p: "п",
  q: "к",
  r: "р",
  s: "с",
  t: "т",
  u: "у",
  v: "в",
  w: "в",
  x: "кс",
  y: "и",
  z: "з",
};

export function latinToCyrillic(s: string) {
  return [...s]
    .map((ch) => LAT_TO_CYR[ch] ?? LAT_TO_CYR[ch.toLocaleLowerCase("en")] ?? ch)
    .join("");
}

function foldLatinTokens(q: string) {
  return q
    .split(" ")
    .filter(Boolean)
    .map((token) =>
      /[a-z]/i.test(token) && !/[а-яё]/i.test(token)
        ? latinToCyrillic(token.toLocaleLowerCase("en"))
        : token,
    )
    .join(" ");
}

export function mentionsDrive(text: string) {
  return DRIVE_HINT.test(
    text
      .toLocaleLowerCase("ru")
      .replace(/ё/g, "е"),
  );
}

export function compileDriveQuery(text: string) {
  let q = text
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(DRIVE_HINT, " ")
    .replace(FIND, " ")
    .replace(/(?<!\p{L})\p{L}*кро[йюе]\p{L}*(?!\p{L})/gu, " ")
    .replace(/(?<!\p{L})(?:с|со|из|на|в)(?!\p{L})/gu, " ")
    .replace(
      /(?<!\p{L})(?:мне|пожалуйста|файл\p{L}*|под названием|с названием|по названию|называется)(?!\p{L})/gu,
      " ",
    )
    .replace(/[.,!?;:]+$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const extras: string[] = [];
  for (const [pattern, token] of TYPES) {
    if (pattern.test(q)) {
      extras.push(token);
      q = q.replace(pattern, " ");
    }
  }
  for (const [pattern, token] of DATES) {
    if (pattern.test(q)) {
      extras.push(token);
      q = q.replace(pattern, " ");
    }
  }
  if (/(?<!\p{L})последн\p{L}*(?!\p{L})/u.test(q)) {
    extras.push("after:14d");
    q = q.replace(/(?<!\p{L})последн\p{L}*(?!\p{L})/gu, " ");
  }
  q = foldLatinTokens(q.replace(/\s+/g, " ").trim());
  return [...extras, q].filter(Boolean).join(" ").trim();
}

export function extractSpokenDrive(text: string) {
  if (!mentionsDrive(text)) return undefined;
  return { query: compileDriveQuery(text) };
}

function normalizeDriveName(s: string) {
  return s
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[_./\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function driveTokens(s: string) {
  return normalizeDriveName(s)
    .split(" ")
    .filter((token) => token.length >= 3 && !token.includes(":"));
}

function glueShortTokens(tokens: string[]) {
  const out: string[] = [];
  let buf = "";
  for (const token of tokens) {
    if (token.length <= 3) buf += token;
    else {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      out.push(token);
    }
  }
  if (buf) out.push(buf);
  return out.filter(Boolean);
}

function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  const rows = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = rows[0];
    rows[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = rows[j];
      rows[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, rows[j], rows[j - 1]);
      prev = cur;
    }
  }
  return rows[b.length];
}

export function driveSearchVariants(query: string) {
  const compiled = compileDriveQuery(query) || query.trim();
  const extras = compiled.split(" ").filter((token) => token.includes(":"));
  const tokens = driveTokens(compiled);
  const glued = glueShortTokens(compiled.split(" ").filter(Boolean));
  const variants = new Set<string>();
  const add = (value: string) => {
    const text = [...extras, value].filter(Boolean).join(" ").trim();
    if (text) variants.add(text);
  };
  if (compiled) variants.add(compiled);
  if (tokens.length) {
    add(tokens.join(" "));
    add(tokens.join("_"));
    add(tokens.join("-"));
    add(glued.join(""));
  }
  for (const token of tokens.filter((item) => item.length >= 4)) add(token);
  return [...variants].slice(0, 6);
}

export function scoreDriveName(name: string, query: string) {
  const n = normalizeDriveName(name);
  const q = normalizeDriveName(compileDriveQuery(query) || query);
  if (!n || !q) return 0;
  const nCompact = n.replace(/\s+/g, "");
  const qCompact = glueShortTokens(q.split(" ").filter(Boolean)).join("");
  if (n === q || nCompact === qCompact) return 1000;
  if (qCompact.length >= 4 && nCompact.includes(qCompact)) return 860;
  if (nCompact.length >= 4 && qCompact.includes(nCompact)) return 780;
  const dist = levenshtein(nCompact, qCompact);
  const len = Math.max(nCompact.length, qCompact.length);
  if (len >= 6 && dist <= 2) return 820;
  if (len >= 8 && dist <= 4) return 740;
  const qTokens = driveTokens(q);
  const nTokens = driveTokens(n);
  if (!qTokens.length) return 0;
  let hit = 0;
  for (const token of qTokens) {
    if (
      nTokens.some(
        (part) => part === token || part.includes(token) || token.includes(part),
      ) ||
      nCompact.includes(token)
    )
      hit += 1;
  }
  if (qTokens.length >= 2 && hit < 2) return 0;
  if (!hit) return 0;
  return Math.round(360 + (hit / qTokens.length) * 400);
}

export function pickDriveHit<T extends { name: string; kind?: string }>(
  hits: T[],
  query: string,
) {
  const scored = hits
    .map((hit) => ({
      hit,
      score:
        scoreDriveName(hit.name, query) + (hit.kind === "folder" ? -120 : 50),
    }))
    .filter((item) => item.score >= 500)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.hit;
}
