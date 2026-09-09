import { domainToASCII } from "node:url";
import type {
  AssistantDecision,
  Registry,
} from "../../../packages/shared/src/index.js";
import { execute } from "./intent.js";

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

const KNOWN_SITES: Array<{ aliases: string[]; host: string }> = [
  { aliases: ["егов", "egov", "госуслуги", "госуслуга"], host: "egov.kz" },
  { aliases: ["гов кз", "gov kz", "gov.kz"], host: "gov.kz" },
  { aliases: ["каспи", "kaspi"], host: "kaspi.kz" },
  { aliases: ["крыша", "krisha"], host: "krisha.kz" },
  { aliases: ["колеса", "kolesa"], host: "kolesa.kz" },
  { aliases: ["тенгри", "tengrinews"], host: "tengrinews.kz" },
  { aliases: ["нур кз", "nur.kz", "nur kz"], host: "nur.kz" },
  { aliases: ["два гис", "2гис", "2gis", "две гис"], host: "2gis.kz" },
  { aliases: ["эйч эйч", "hh kz", "hh.kz"], host: "hh.kz" },
  { aliases: ["ютуб", "ютьюб", "youtube", "you tube"], host: "youtube.com" },
  { aliases: ["инстаграм", "инста", "instagram"], host: "instagram.com" },
  { aliases: ["фейсбук", "facebook"], host: "facebook.com" },
  { aliases: ["тикток", "tiktok", "тик ток"], host: "tiktok.com" },
  { aliases: ["гитхаб", "github", "git hub"], host: "github.com" },
  { aliases: ["чатгпт", "chatgpt", "чат джипити", "чат gpt"], host: "chatgpt.com" },
  { aliases: ["гугл", "google"], host: "google.com" },
  { aliases: ["джимейл", "gmail", "гмейл"], host: "gmail.com" },
  { aliases: ["гугл диск", "google drive"], host: "drive.google.com" },
  { aliases: ["карты гугл", "гугл карты", "google maps"], host: "maps.google.com" },
  { aliases: ["переводчик", "google translate"], host: "translate.google.com" },
  { aliases: ["википедия", "wikipedia"], host: "wikipedia.org" },
  { aliases: ["вайлдберриз", "wildberries", "вб"], host: "www.wildberries.ru" },
  { aliases: ["озон", "ozon"], host: "www.ozon.ru" },
  { aliases: ["авито", "avito"], host: "www.avito.ru" },
  { aliases: ["линкедин", "linkedin"], host: "linkedin.com" },
  { aliases: ["ватсап веб", "whatsapp web"], host: "web.whatsapp.com" },
  { aliases: ["нетфликс", "netflix"], host: "netflix.com" },
  { aliases: ["спотифай", "spotify"], host: "open.spotify.com" },
  { aliases: ["твиттер", "twitter"], host: "x.com" },
];

const SPOKEN_TLDS: Array<[RegExp, string]> = [
  [/точка\s+(?:кз|kaz|кей[\s-]?зи)/g, ".kz"],
  [/точка\s+(?:ком|com)/g, ".com"],
  [/точка\s+(?:ру|ru)/g, ".ru"],
  [/точка\s+(?:орг|org)/g, ".org"],
  [/точка\s+(?:нет|net)/g, ".net"],
  [/точка\s+(?:ай|аи|ai)/g, ".ai"],
  [/точка\s+(?:ио|io)/g, ".io"],
];

const BROWSERS: Array<{ test: RegExp; id: string }> = [
  {
    test: /хром|chrome|гугл хром|голого храма|голову срама|голову храма|голого хрома/,
    id: "chrome",
  },
  { test: /сафари|safari/, id: "safari" },
  { test: /firefox|фаерфокс|файрфокс/, id: "firefox" },
  { test: /edge|эдж/, id: "edge" },
];

const FILLER =
  /(?:^|\s)(?:открой|открыть|открою|откроем|откройте|запусти|запустить|включи|покажи|сайт|сайта|вкладк\p{L}*|браузер\p{L}*|пожалуйста|мне|через|https|http|www)(?=\s|$)/gu;

export function prepareSpokenWeb(text: string) {
  let q = text
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/https?:\/\//g, " ")
    .replace(/www\./g, " ");
  for (const [pattern, tld] of SPOKEN_TLDS) q = q.replace(pattern, tld);
  q = q.replace(/\s*\.\s*/g, ".");
  q = q.replace(
    /(\p{L}[\p{L}\p{N}-]*)\s+(кз|kz|ком|com|ру|ru|орг|org|нет|net|ай|ai|ио|io)(?=\s|$)/gu,
    (_, host: string, tld: string) =>
      host +
      "." +
      ({ ком: "com", ру: "ru", орг: "org", нет: "net", ай: "ai", ио: "io", кз: "kz" }[
        tld
      ] ?? tld),
  );
  return q.replace(/\s+/g, " ").trim();
}

export function transliterateHost(host: string) {
  return [...host.toLocaleLowerCase("ru")]
    .map((ch) => CYR_TO_LAT[ch] ?? ch)
    .join("");
}

export function toHttpsUrl(host: string) {
  const ascii = domainToASCII(transliterateHost(host.replace(/^www\./, "www.")));
  if (!ascii || ascii.includes("://") || /[^\w.-]/.test(ascii))
    throw new Error("invalid host");
  return "https://" + ascii;
}

export function browserFromText(text: string, registry?: Registry) {
  const q = text.toLocaleLowerCase("ru").replace(/ё/g, "е");
  const match = BROWSERS.find((browser) => browser.test.test(q));
  if (!match) return undefined;
  if (
    registry &&
    !registry.applications.some((app) => app.id === match.id)
  )
    return undefined;
  return match.id;
}

function worded(q: string, alias: string) {
  const needle = alias
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[.]/g, " ")
    .trim();
  return (" " + q + " ").includes(" " + needle + " ");
}

export function knownSiteHost(text: string) {
  const q = prepareSpokenWeb(text);
  const padded = " " + q.replace(/[.]/g, " ") + " ";
  const chromeApp = /хром|chrome/.test(q) && !/сайт|ютуб|youtube/.test(q);
  for (const site of KNOWN_SITES) {
    if (site.host === "google.com" && chromeApp) continue;
    if (site.aliases.some((alias) => worded(padded, alias))) return site.host;
  }
  return undefined;
}

const HOST_TOKEN = /(?:www\.)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u;

export function extractSpokenUrl(
  text: string,
  registry?: Registry,
): { url: string; applicationId?: string } | undefined {
  const prepared = prepareSpokenWeb(text);
  const applicationId = browserFromText(text, registry);
  const known = knownSiteHost(text);
  if (known) {
    try {
      return { url: toHttpsUrl(known), ...(applicationId ? { applicationId } : {}) };
    } catch {
      return undefined;
    }
  }
  const stripped = prepared.replace(FILLER, " ").replace(/\s+/g, " ").trim();
  const token = stripped.match(HOST_TOKEN)?.[0];
  if (!token) return undefined;
  if (/^(хром|chrome|safari|сафари|cursor|курсор)\./i.test(token))
    return undefined;
  try {
    return {
      url: toHttpsUrl(token),
      ...(applicationId ? { applicationId } : {}),
    };
  } catch {
    return undefined;
  }
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function preferSpokenUrl(
  text: string,
  registry: Registry,
  decision: AssistantDecision,
): AssistantDecision {
  const spoken = extractSpokenUrl(text, registry);
  if (!spoken) return decision;
  if (decision.type === "execute" && decision.action === "open_url") {
    const currentUrl = String(decision.parameters.url ?? "");
    if (hostOf(currentUrl) === hostOf(spoken.url)) {
      if (!spoken.applicationId || decision.parameters.applicationId)
        return decision;
      return execute(
        {
          action: "open_url",
          parameters: {
            url: currentUrl,
            applicationId: spoken.applicationId,
          },
        },
        decision.spokenResponse,
      );
    }
  }
  return execute(
    { action: "open_url", parameters: spoken },
    "Открываю " + spoken.url,
  );
}
