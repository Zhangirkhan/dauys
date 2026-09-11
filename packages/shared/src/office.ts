export type OfficeKind = "word" | "excel";

const normalize = (s: string) =>
  s
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const EXCEL =
  /(?<!\p{L})(?:эксел\p{L}*|аксел\p{L}*|акцел\p{L}*|excel|майкрософт эксел\p{L}*)(?!\p{L})/u;
const WORD =
  /(?<!\p{L})(?:ворд\p{L}*|word|майкрософт ворд\p{L}*)(?!\p{L})/u;
const NEW_OR_CREATE =
  /(?:создай|создать|сделай)|(?:открой|открыть|открою|откроем|откройте).{0,40}нов|(?:^| )нов(?:ый|ое|ую|ая) |пуст(?:ой|ое|ую|ая) /u;
const EDITOR_OR_PROJECT = /курсор|cursor|vscode|проект/u;

export function officeAppQuery(kind: OfficeKind) {
  return kind === "excel" ? "excel" : "word";
}

export function spokenOfficeKind(text: string): OfficeKind | undefined {
  const q = normalize(text);
  const excel = EXCEL.test(q);
  const word = WORD.test(q);
  if (excel === word) return undefined;
  return excel ? "excel" : "word";
}

export function officeKindForExtension(ext: string): OfficeKind | undefined {
  const value = ext.toLowerCase().replace(/^\./, "");
  if (["doc", "docx", "docm"].includes(value)) return "word";
  if (["xls", "xlsx", "xlsm"].includes(value)) return "excel";
  return undefined;
}

export function isOfficeAppName(name: string) {
  const n = name.toLocaleLowerCase("en");
  return (
    /microsoft excel|^excel$/.test(n) || /microsoft word|^word$/.test(n)
  );
}

export function extractNewOfficeDocument(text: string):
  | { kind: OfficeKind; title?: string }
  | undefined {
  const q = normalize(text);
  if (EDITOR_OR_PROJECT.test(q)) return undefined;
  if (!NEW_OR_CREATE.test(q)) return undefined;
  const kind = spokenOfficeKind(q);
  if (!kind) return undefined;
  const title = stripOfficeFiller(q);
  return title ? { kind, title } : { kind };
}

export function extractCloseOffice(text: string):
  | { kind: OfficeKind; documentOnly: boolean }
  | undefined {
  const q = normalize(text);
  if (!/(?:^| )(?:закрой|закрыть|закройте)(?: |$)/.test(" " + q + " "))
    return undefined;
  const kind = spokenOfficeKind(q);
  if (!kind) return undefined;
  return { kind, documentOnly: /документ|таблиц|книг/.test(q) };
}

function stripOfficeFiller(q: string) {
  const title = q
    .replace(
      /(?:^| )(?:создай|создать|сделай|открой|открыть|открою|откроем|откройте|пожалуйста)(?= |$)/gu,
      " ",
    )
    .replace(
      /(?:^| )(?:новый|новое|новую|новая|пустой|пустое|пустую|пустая)(?= |$)/gu,
      " ",
    )
    .replace(
      /(?:^| )(?:эксел\p{L}*|аксел\p{L}*|акцел\p{L}*|excel|ворд\p{L}*|word|майкрософт)(?= |$)/gu,
      " ",
    )
    .replace(
      /(?:^| )(?:документ\p{L}*|файл\p{L}*|таблиц\p{L}*|книг\p{L}*|в|на)(?= |$)/gu,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (!title || /^(его|ее|это|этот|тот)$/.test(title) || title.length > 60)
    return undefined;
  return title;
}
