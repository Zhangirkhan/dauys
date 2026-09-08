import type {
  AssistantDecision,
  Registry,
} from "../../../packages/shared/src/index.js";
import { execute } from "./intent.js";

const normalize = (s: string) =>
  s
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export type SpokenItem = {
  query: string;
  kind: "file" | "folder" | "any";
};

const OPEN =
  /^(?:открой|открыть|открою|откроем|откройте|покажи|найди|найти)(?:те)? /u;
const NEW_EDITOR =
  /(?:создай|открой|открыть|открою|откроем|откройте).{0,30}нов(?:ый|ое|ую)|нов(?:ый|ое|ую) (?:проект|окно)|пуст(?:ое|ой|ую) (?:окно|проект)|new (?:project|window)/u;

function cleanQuery(raw: string) {
  return normalize(raw)
    .replace(/^(?:в|через) (?:курсоре?|cursor) /, "")
    .replace(/^(?:с названием|под названием|по названию|с именем|по имени) /, "")
    .replace(/^(?:проект[аеу]? )/, "")
    .replace(/^с /, "")
    .replace(
      / (?:в|через) (?:курсоре?|cursor|файндере?|finder|проводнике?)$/u,
      "",
    )
    .replace(/ проект[аеу]?$/u, "")
    .replace(/ пожалуйста$/u, "")
    .trim();
}

export function extractSpokenItem(text: string): SpokenItem | undefined {
  let q = normalize(text).replace(/ пожалуйста$/u, "").trim();
  if (!OPEN.test(q)) return undefined;
  q = q
    .replace(OPEN, "")
    .replace(/^мне /, "")
    .replace(/^пожалуйста /, "")
    .trim();
  const folderMatch = q.match(
    /^(?:папк\p{L}*|каталог\p{L}*|директор\p{L}*)(?: (.+))?$/u,
  );
  if (folderMatch) {
    const query = cleanQuery(folderMatch[1] ?? "");
    if (/^(его|ее|это|этот|тот|последний)$/.test(query)) return undefined;
    return { query, kind: "folder" };
  }
  const fileMatch = q.match(/^(?:файл\p{L}*)(?: (.+))?$/u);
  if (fileMatch) {
    const query = cleanQuery(fileMatch[1] ?? "");
    if (/^(его|ее|это|этот|тот|последний)$/.test(query)) return undefined;
    return { query, kind: "file" };
  }
  const query = cleanQuery(q);
  if (!query || /^(его|ее|это|этот|тот|последний)$/.test(query))
    return undefined;
  if (/^(проект[аеу]?|в курсоре|в cursor)$/.test(query)) return undefined;
  return { query, kind: "any" };
}

function editorFromText(text: string, registry: Registry) {
  const n = normalize(text);
  if (!/курсор|cursor|vscode|vs code/.test(n)) return undefined;
  return registry.applications.find(
    (app) =>
      app.id === "cursor" ||
      normalize(app.name) === "cursor" ||
      /visual studio code|^code$/i.test(app.name),
  );
}

function namedApp(registry: Registry, query: string) {
  const n = normalize(query);
  if (!n) return undefined;
  return registry.applications.find((app) =>
    [app.name, ...app.aliases].some((alias) => normalize(alias) === n),
  );
}

function projectForQuery(registry: Registry, query: string) {
  const n = normalize(query);
  if (!n) return undefined;
  return registry.projects.find((project) =>
    [project.name, ...project.aliases].some((alias) => normalize(alias) === n),
  );
}

function withEditor(
  query: string,
  kind: SpokenItem["kind"],
  text: string,
  registry: Registry,
) {
  const editor = editorFromText(text, registry);
  return execute(
    {
      action: "open_named_item",
      parameters: {
        query,
        kind,
        ...(editor ? { applicationId: editor.id } : {}),
      },
    },
    editor ? "Ищу проект " + query : "Ищу и открываю " + query,
  );
}

export function preferSpokenNamedItem(
  text: string,
  registry: Registry,
  decision: AssistantDecision,
): AssistantDecision {
  const editor = editorFromText(text, registry);
  if (NEW_EDITOR.test(normalize(text)) && editor)
    return execute(
      {
        action: "open_application",
        parameters: { applicationId: editor.id, newWindow: true },
      },
      "Открываю новое окно " + editor.name,
    );
  const spoken = extractSpokenItem(text);
  if (!spoken) return decision;
  if (!spoken.query) {
    return {
      type: "clarification",
      question:
        spoken.kind === "file"
          ? "Какой файл открыть? Назовите его."
          : "Какую папку открыть? Назовите её.",
    };
  }
  const app = namedApp(registry, spoken.query);
  if (app && spoken.kind === "any") {
    if (
      decision.type === "execute" &&
      decision.action === "open_application" &&
      decision.parameters.applicationId === app.id &&
      !decision.parameters.newWindow
    )
      return decision;
    return execute(
      { action: "open_application", parameters: { applicationId: app.id } },
      "Открываю " + app.name,
    );
  }
  const namedProject = projectForQuery(registry, spoken.query);
  if (spoken.kind === "folder" || spoken.kind === "file") {
    if (spoken.kind === "folder" && namedProject && !editor)
      return execute(
        { action: "open_folder", parameters: { path: namedProject.path } },
        "Открываю папку " + namedProject.name,
      );
    if (spoken.kind === "folder" && namedProject && editor)
      return execute(
        {
          action: "open_project",
          parameters: {
            projectId: namedProject.id,
            applicationId: editor.id,
          },
        },
        "Открываю " + namedProject.name + " в " + editor.name,
      );
    return withEditor(spoken.query, spoken.kind, text, registry);
  }
  const askedForProject = /проект/.test(normalize(text));
  if (
    decision.type === "execute" &&
    (decision.action === "open_project" || decision.action === "open_folder")
  ) {
    if (namedProject) return decision;
    if (
      askedForProject &&
      decision.action === "open_project" &&
      decision.parameters.projectId &&
      registry.projects.some(
        (project) =>
          project.id === decision.parameters.projectId &&
          [project.name, ...project.aliases].some((alias) =>
            spoken.query.includes(normalize(alias)),
          ),
      )
    )
      return decision;
    return withEditor(
      spoken.query,
      askedForProject ? "folder" : "any",
      text,
      registry,
    );
  }
  if (decision.type !== "execute") {
    if (askedForProject || editor)
      return withEditor(
        spoken.query,
        askedForProject ? "folder" : spoken.kind,
        text,
        registry,
      );
    return withEditor(spoken.query, spoken.kind, text, registry);
  }
  return decision;
}
