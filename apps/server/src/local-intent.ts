import type {
  AssistantDecision,
  Registry,
} from "../../../packages/shared/src/index.js";
import {
  execute,
  ordinal,
  type IntentInput,
  type IntentResolver,
} from "./intent.js";
import { extractSpokenItem } from "./named-item.js";
import { extractSpokenUrl } from "./spoken-url.js";
import { extractSpokenDrive } from "../../../packages/shared/src/index.js";

const normalize = (s: string) =>
  s
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const HOSTISH =
  /[\p{L}\p{N}-]+\.[\p{L}\p{N}-]+|точка\s+(?:кз|ком|kz|com)|егов|egov|ютуб|youtube/u;
type Entity = { id: string; name: string; aliases: string[] };
// Prefer a compound name (BetGPT Mobile) over the shorter name it contains,
// but keep separate named objects ambiguous rather than choosing one arbitrarily.
export function localMatches<T extends Entity>(
  text: string,
  entities: T[],
): T[] {
  const q = " " + normalize(text) + " ";
  const hits = entities.flatMap((entity) =>
    [entity.name, ...entity.aliases].flatMap((alias) => {
      const normalized = normalize(alias);
      if (!normalized) return [];
      const match = " " + normalized + " ";
      const start = q.indexOf(match);
      return start < 0 ? [] : [{ entity, start, end: start + match.length }];
    }),
  );
  const retained = hits.filter(
    (h) =>
      !hits.some(
        (other) =>
          other.entity.id !== h.entity.id &&
          other.start <= h.start &&
          other.end >= h.end &&
          (other.start < h.start || other.end > h.end),
      ),
  );
  return entities.filter((entity) =>
    retained.some((h) => h.entity.id === entity.id),
  );
}
function chooseProjects(
  registry: Registry,
  question = "Какой проект открыть?",
): AssistantDecision {
  return {
    type: "clarification",
    question,
    options: registry.projects
      .slice(0, 10)
      .map((p) => ({ id: "project:" + p.id, label: p.name })),
  };
}
export class LocalIntentResolver implements IntentResolver {
  async resolve({
    text,
    registry,
    context,
    pending,
  }: IntentInput): Promise<AssistantDecision> {
    const answer = normalize(text),
      original = normalize(pending?.originalText ?? text);
    const q = pending ? original + " " + answer : answer;
    if (
      /удал|отправ.*(?:сообщ|письм)|купи|парол|keychain|терминал|shell|sudo|выполни код/.test(
        q,
      )
    )
      return {
        type: "reject",
        reason:
          "Это действие запрещено. Можно открыть программу или зарегистрированный проект.",
      };
    const drive = extractSpokenDrive(pending ? pending.originalText + " " + text : text);
    if (drive) {
      if (!drive.query)
        return {
          type: "clarification",
          question: "Какой файл найти на диске? Назовите имя, тип или дату.",
        };
      return execute(
        {
          action: "search_drive",
          parameters: { query: drive.query, open: true },
        },
        "Ищу на диске: " + drive.query,
      );
    }
    if (
      /(?:^| )(?:не|нельзя) (?:откр|запус|включ|закр)|(?:^| )(?:как|зачем|почему) (?:откр|запус|закр)/.test(
        q,
      )
    )
      return {
        type: "clarification",
        question:
          "Для выполнения скажите, например: «Открой Telegram» или «Открой проект в Cursor».",
      };
    const close = /(?:^| )(?:закрой|закрыть|закройте)(?: |$)/.test(q);
    const opening =
      /(?:^| )(?:открой|открыть|открою|откроем|откройте|запусти|запустить|включи|покажи)(?: |$)|поработ|продолж/.test(
        q,
      );
    let projects = localMatches(text, registry.projects),
      apps = localMatches(text, registry.applications);
    if (pending?.options?.length) {
      const index = ordinal(text);
      const option =
        pending.options.find((o) => o.id === text.trim()) ??
        (index === undefined ? undefined : pending.options[index]);
      if (option) {
        if (option.id.startsWith("project:"))
          projects = registry.projects.filter(
            (p) => p.id === option.id.slice(8),
          );
        if (option.id.startsWith("app:"))
          apps = registry.applications.filter(
            (a) => a.id === option.id.slice(4),
          );
      }
      // Preserve an explicitly chosen editor when the following utterance selects a project.
      if (!apps.length)
        apps = localMatches(pending.originalText, registry.applications);
    }
    if (/батар|заряд/.test(q))
      return execute(
        { action: "get_battery_status", parameters: {} },
        "Проверяю заряд Mac",
      );
    if (/что (?:сейчас )?открыто|активн.*прилож/.test(q))
      return execute(
        { action: "get_active_application", parameters: {} },
        "Проверяю активное приложение",
      );
    if (/(?:заблокируй|заблокировать) (?:экран|мак|mac)/.test(q))
      return execute(
        { action: "lock_screen", parameters: {} },
        "Заблокировать Mac?",
      );
    if (/громк|звук на/.test(q)) {
      const value = answer.match(/\d+/)?.[0] ?? q.match(/\d+/)?.[0];
      if (!value || Number(value) > 100)
        return {
          type: "clarification",
          question: "Укажите громкость числом от 0 до 100.",
        };
      return execute(
        { action: "set_volume", parameters: { volume: Number(value) } },
        "Устанавливаю громкость " + value + "%",
      );
    }
    if (projects.length > 1)
      return {
        type: "clarification",
        question: "Какой из проектов открыть?",
        options: projects
          .map((p) => ({ id: "project:" + p.id, label: p.name }))
          .slice(0, 10),
      };
    if (apps.length > 1)
      return {
        type: "clarification",
        question: "Какую программу выбрать?",
        options: apps
          .map((a) => ({ id: "app:" + a.id, label: a.name }))
          .slice(0, 10),
      };
    let project: Registry["projects"][number] | undefined = projects[0];
    let app: Registry["applications"][number] | undefined = apps[0];
    const refersBack = /(?:^| )(?:его|ее|этот|тот|последний)(?: |$)/.test(q);
    const asksProject = /проект|поработ|продолж/.test(q);
    const asksSite = /сайт/.test(q);
    const spokenUrl = extractSpokenUrl(
      pending ? original + " " + answer : text,
      registry,
    );
    if (spokenUrl && (opening || asksSite || HOSTISH.test(q)))
      return execute(
        { action: "open_url", parameters: spokenUrl },
        "Открываю " + spokenUrl.url,
      );
    const wantsNewEditor =
      /(?:создай|открой|открыть|открою|откроем|откройте).{0,30}нов(?:ый|ое|ую)|нов(?:ый|ое|ую) (?:проект|окно)|пуст(?:ое|ой|ую) (?:окно|проект)|new (?:project|window)/.test(
        q,
      );
    if (
      !project &&
      !app &&
      refersBack &&
      context.recent.at(-1)?.action === "open_application" &&
      !asksProject &&
      !asksSite
    ) {
      app = registry.applications.find(
        (a) => a.id === context.lastApplication,
      )!;
    }
    if (!project && ((refersBack && !app) || (asksSite && !spokenUrl)))
      project = registry.projects.find((p) => p.id === context.activeProject)!;
    if (asksSite && opening && !spokenUrl) {
      if (!project)
        return chooseProjects(registry, "Сайт какого проекта открыть?");
      const url = /локальн/.test(q)
        ? project.urls.local
        : (project.urls.production ?? project.urls.local);
      return url
        ? execute(
            { action: "open_url", parameters: { url } },
            "Открываю сайт " + project.name,
          )
        : {
            type: "reject",
            reason:
              "Для проекта " +
              project.name +
              " не настроен сайт. Добавьте URL в настройках.",
          };
    }
    if (wantsNewEditor) {
      const editor =
        app ??
        registry.applications.find((a) => a.id === "cursor") ??
        registry.applications.find((a) => /cursor|visual studio code/i.test(a.name));
      if (editor)
        return execute(
          {
            action: "open_application",
            parameters: { applicationId: editor.id, newWindow: true },
          },
          "Открываю новое окно " + editor.name,
        );
    }
    if (/нов(?:ую|ая) вкладк/.test(q)) {
      const browser =
        app ?? registry.applications.find((a) => a.id === "chrome");
      if (browser)
        return execute(
          {
            action: "new_browser_tab",
            parameters: { applicationId: browser.id },
          },
          "Открываю новую вкладку в " + browser.name,
        );
    }
    const spoken = extractSpokenItem(pending ? original + " " + answer : text);
    if (spoken && (spoken.kind === "folder" || spoken.kind === "file")) {
      if (!spoken.query)
        return {
          type: "clarification",
          question:
            spoken.kind === "file"
              ? "Какой файл открыть? Назовите его."
              : "Какую папку открыть? Назовите её.",
        };
      const namedProject = registry.projects.find((item) =>
        [item.name, ...item.aliases].some(
          (alias) => normalize(alias) === spoken.query,
        ),
      );
      if (spoken.kind === "folder" && namedProject)
        return execute(
          app
            ? {
                action: "open_project",
                parameters: {
                  projectId: namedProject.id,
                  applicationId: app.id,
                },
              }
            : { action: "open_folder", parameters: { path: namedProject.path } },
          app
            ? "Открываю " + namedProject.name + " в " + app.name
            : "Открываю папку " + namedProject.name,
        );
      return execute(
        {
          action: "open_named_item",
          parameters: {
            query: spoken.query,
            kind: spoken.kind,
            ...(app ? { applicationId: app.id } : {}),
          },
        },
        "Ищу и открываю " + spoken.query,
      );
    }
    const bareEntity = !![project, app].find(
      (e) =>
        e &&
        [e.name, ...e.aliases].some((alias) => normalize(alias) === answer),
    );
    if (!opening && !close && !pending && !bareEntity)
      return {
        type: "clarification",
        question:
          "Скажите «Открой» и название программы или проекта. Например: «Открой Telegram».",
      };
    if (close) {
      if (!app)
        return {
          type: "clarification",
          question: "Какое приложение закрыть?",
          options: registry.applications
            .slice(0, 10)
            .map((a) => ({ id: "app:" + a.id, label: a.name })),
        };
      return execute(
        { action: "close_application", parameters: { applicationId: app.id } },
        "Закрыть " + app.name + "?",
      );
    }
    if (project) {
      if (/(?:запусти|запустить).*(?:сервер|сценарий)/.test(q)) {
        if (!project.scenarios.start_work)
          return {
            type: "reject",
            reason:
              "У проекта нет сценария start_work. Его можно добавить в настройках.",
          };
        return execute(
          {
            action: "run_scenario",
            parameters: { projectId: project.id, scenarioId: "start_work" },
          },
          "Запустить сценарий " + project.name + "?",
        );
      }
      return execute(
        {
          action: "open_project",
          parameters: {
            projectId: project.id,
            ...(app ? { applicationId: app.id } : {}),
          },
        },
        "Открываю " +
          project.name +
          " в " +
          (app?.name ?? project.defaultApplication),
      );
    }
    if (asksProject && spoken?.kind !== "folder" && spoken?.kind !== "file") {
      const query = spoken?.query;
      if (query) {
        const editor =
          app ??
          registry.applications.find((a) => a.id === "cursor") ??
          registry.applications.find((a) => /cursor/i.test(a.name));
        return execute(
          {
            action: "open_editor_project",
            parameters: {
              query,
              ...(editor ? { applicationId: editor.id } : {}),
            },
          },
          "Ищу проект " + query,
        );
      }
      return {
        type: "clarification",
        question:
          "Какой проект открыть? Назовите папку или скажите «новый проект».",
        options: registry.projects
          .slice(0, 10)
          .map((p) => ({ id: "project:" + p.id, label: p.name })),
      };
    }
    // A named application wins over an old active project. Context must not invent a target.
    if (app)
      return execute(
        { action: "open_application", parameters: { applicationId: app.id } },
        "Открываю " + app.name,
      );
    if (opening && spoken?.query)
      return execute(
        {
          action: "open_named_item",
          parameters: {
            query: spoken.query,
            kind: spoken.kind,
          },
        },
        "Ищу и открываю " + spoken.query,
      );
    return {
      type: "clarification",
      question:
        "Не нашёл такое название. Скажите папку, файл, программу или проект.",
      options: registry.applications
        .slice(0, 10)
        .map((a) => ({ id: "app:" + a.id, label: a.name })),
    };
  }
}
