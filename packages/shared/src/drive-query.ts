const DRIVE_HINT =
  /(?:^| )(?:на|с|со|из|в) (?:диске|диска|драйве|драйва|облаке|облака)(?: |$)|drive esl|драйв(?: есл)?|корпоративн\p{L}* диск|файлов\p{L}* облак/u;

const FIND =
  /(?:найди|найти|открой|открыть|открою|покажи|вытащи|скачай|скачать|принеси|дай)(?:те)? /u;

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
    .replace(/(?<!\p{L})(?:мне|пожалуйста|файл\p{L}*)(?!\p{L})/gu, " ")
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
  q = q.replace(/\s+/g, " ").trim();
  return [...extras, q].filter(Boolean).join(" ").trim();
}

export function extractSpokenDrive(text: string) {
  if (!mentionsDrive(text)) return undefined;
  return { query: compileDriveQuery(text) };
}
