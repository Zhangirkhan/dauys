import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { stat, mkdir, writeFile, access } from "node:fs/promises";
import { join, basename, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  actionSchema,
  requiresConfirmation,
  type Action,
  type Registry,
  type ExecutionResult,
  type FileMatch,
  type Trust,
} from "../../../packages/shared/src/index.js";
import { guardPath, documentExtensions } from "./safety.js";
const exec = promisify(execFile);

const normalizeName = (s: string) =>
  s
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function knownFolderPath(query: string): string | undefined {
  const n = normalizeName(query);
  if (!n) return undefined;
  const home = homedir();
  const folders: Array<[string[], string]> = [
    [
      [
        "downloads",
        "download",
        "загрузки",
        "загрузка",
        "загрузках",
        "загрузок",
        "загрузками",
        "загрузку",
      ],
      join(home, "Downloads"),
    ],
    [
      [
        "documents",
        "document",
        "документы",
        "документах",
        "документов",
        "документами",
      ],
      join(home, "Documents"),
    ],
    [
      ["desktop", "рабочий стол", "рабочем столе", "рабочего стола"],
      join(home, "Desktop"),
    ],
    [
      ["pictures", "изображения", "изображений", "фотографии"],
      join(home, "Pictures"),
    ],
    [["music", "музыка", "музыку", "музыки"], join(home, "Music")],
    [["movies", "фильмы", "фильмов", "видео"], join(home, "Movies")],
  ];
  for (const [names, path] of folders)
    if (names.some((name) => n === name || n.startsWith(name))) return path;
  return undefined;
}

export function rankNamedMatches(paths: string[], needle: string): string[] {
  const n = normalizeName(needle);
  const score = (path: string) => {
    const name = normalizeName(basename(path));
    const stem = normalizeName(basename(path, extname(path)));
    let s = 0;
    if (name === n || stem === n) s += 1000;
    else if (name.startsWith(n) || stem.startsWith(n)) s += 300;
    else if (name.includes(n) || stem.includes(n)) s += 80;
    s -= path.split("/").filter(Boolean).length * 8;
    if (
      /\/(Desktop|Documents|Downloads|Developer|Movies|Music|Pictures)(\/|$)/i.test(
        path,
      )
    )
      s += 120;
    if (/\/(Library|node_modules|\.git|\.venv|dist)\//.test(path)) s -= 600;
    return s;
  };
  return [...new Set(paths)].sort(
    (a, b) => score(b) - score(a) || a.length - b.length,
  );
}
export type ExecutorOptions = {
  real: boolean;
  roots: string[];
  trust: Trust;
  dataDir: string;
};
export class MacExecutor {
  constructor(private o: ExecutorOptions) {}
  private async run(file: string, args: string[]) {
    const { stdout } = await exec(file, args, {
      timeout: 12000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout.trim();
  }
  private async activate(applicationName: string) {
    await this.run("/usr/bin/open", ["-a", applicationName]);
  }
  private async findEditorCli(appPath: string | undefined, appName: string) {
    const bases = [
      appPath,
      `/Applications/${appName}.app`,
      join(homedir(), "Desktop", `${appName}.app`),
      join(homedir(), "Applications", `${appName}.app`),
    ].filter((path): path is string => !!path);
    for (const base of bases) {
      for (const bin of ["cursor", "code"]) {
        const candidate = join(base, "Contents/Resources/app/bin", bin);
        try {
          await access(candidate);
          return candidate;
        } catch {
          continue;
        }
      }
    }
  }
  private async openEditor(
    name: string,
    appPath: string | undefined,
    options: { folder?: string; newWindow?: boolean } = {},
  ) {
    const cli = await this.findEditorCli(appPath, name);
    if (cli && (options.folder || options.newWindow)) {
      const args = [
        ...(options.newWindow ? ["-n"] : []),
        ...(options.folder ? [options.folder] : []),
      ];
      await this.run(cli, args.length ? args : ["-n"]);
      return;
    }
    if (options.newWindow) {
      await this.run("/usr/bin/open", ["-na", appPath ?? name]);
      return;
    }
    if (options.folder) {
      await this.run("/usr/bin/open", ["-a", appPath ?? name, options.folder]);
      return;
    }
    await this.activate(name);
  }
  async execute(
    command: Action,
    registry: Registry,
    confirmed = false,
    expiresAt = Date.now() + 60000,
  ): Promise<ExecutionResult> {
    try {
      const c = actionSchema.parse(command);
      if (requiresConfirmation(c) && !confirmed)
        throw new Error("Для действия требуется подтверждение");
      if (Date.now() >= expiresAt) throw new Error("Команда истекла");
      if (this.o.real && process.platform !== "darwin")
        throw new Error("Реальные действия поддерживаются только на macOS");
      const application = (id: string) => {
        const app = registry.applications.find((a) => a.id === id);
        if (!app) throw new Error("Приложение не зарегистрировано");
        return app.name;
      };
      const applicationPath = (id: string) =>
        registry.applications.find((a) => a.id === id)?.path;
      const project = (id: string) => {
        const p = registry.projects.find((p) => p.id === id);
        if (!p) throw new Error("Проект не зарегистрирован");
        return p;
      };
      if (
        c.action === "open_application" ||
        c.action === "close_application" ||
        c.action === "new_browser_tab"
      )
        application(c.parameters.applicationId);
      if (c.action === "open_project") {
        project(c.parameters.projectId);
        if (c.parameters.applicationId) application(c.parameters.applicationId);
      }
      if (c.action === "run_scenario") {
        if (!confirmed) throw new Error("Сценарий требует подтверждения");
        const p = project(c.parameters.projectId),
          steps = p.scenarios[c.parameters.scenarioId];
        if (!steps) throw new Error("Неизвестный сценарий");
        if (steps.some((s) => s.action === "run_scenario"))
          throw new Error("Вложенные сценарии запрещены");
        const results: ExecutionResult[] = [];
        for (const step of steps) {
          const r = await this.execute(step, registry, confirmed, expiresAt);
          results.push(r);
          if (!r.success) break;
        }
        const proc =
          this.o.trust.processes[p.id + "__" + c.parameters.scenarioId];
        if (proc && results.every((r) => r.success)) {
          if (Date.now() >= expiresAt) throw new Error("Сценарий истёк");
          if (this.o.real) {
            const cwd = await guardPath(proc.cwd, this.o.roots, "project");
            const child = spawn(proc.executable, proc.args, {
              cwd,
              stdio: "ignore",
              detached: true,
              shell: false,
              env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                LANG: process.env.LANG,
              },
            });
            await new Promise<void>((res, rej) => {
              child.once("spawn", res);
              child.once("error", rej);
            });
            child.unref();
            results.push({
              success: true,
              message: "Процесс запущен (это не проверка готовности сервиса)",
              data: { pid: child.pid },
            });
          } else
            results.push({
              success: true,
              message: "Mock: запуск доверенного процесса",
            });
        }
        return {
          success: results.every((r) => r.success),
          message: results.length
            ? results.map((r, i) => `${i + 1}. ${r.message}`).join("\n")
            : "Сценарий не содержит шагов",
          data: { steps: results, mock: !this.o.real },
        };
      }
      if (
        c.action === "run_shortcut" &&
        !this.o.trust.shortcuts.some((s) => s.id === c.parameters.shortcutId)
      )
        throw new Error("Shortcut не разрешён в локальном agent-trust.json");
      if (!this.o.real) return this.mock(c, registry);
      switch (c.action) {
        case "open_application":
          if (c.parameters.applicationId === "finder")
            await this.run("/usr/bin/open", [process.env.HOME ?? "/"]);
          else {
            const name = application(c.parameters.applicationId);
            await this.openEditor(name, applicationPath(c.parameters.applicationId), {
              newWindow: c.parameters.newWindow === true,
            });
          }
          return {
            success: true,
            message: c.parameters.newWindow
              ? "Открыто новое окно: " +
                application(c.parameters.applicationId)
              : "Открыто: " + application(c.parameters.applicationId),
          };
        case "close_application":
          if (!confirmed) throw new Error("Требуется подтверждение");
          await this.run("/usr/bin/osascript", [
            "-e",
            "on run argv\n tell application (item 1 of argv) to quit\nend run",
            application(c.parameters.applicationId),
          ]);
          return {
            success: true,
            message:
              "Запрошено закрытие приложения. Несохранённый документ может требовать ответа на Mac.",
          };
        case "open_project": {
          const p = project(c.parameters.projectId);
          const path = await guardPath(p.path, this.o.roots, "project");
          const name = c.parameters.applicationId
            ? application(c.parameters.applicationId)
            : p.defaultApplication;
          if (!registry.applications.some((a) => a.name === name))
            throw new Error("Редактор не зарегистрирован");
          const appPath = c.parameters.applicationId
            ? applicationPath(c.parameters.applicationId)
            : registry.applications.find((a) => a.name === name)?.path;
          await this.openEditor(name, appPath, { folder: path });
          return { success: true, message: "Открыт проект " + p.name };
        }
        case "open_file":
        case "open_folder": {
          const path = await guardPath(
            c.parameters.path,
            this.o.roots,
            c.action === "open_file" ? "file" : "folder",
          );
          await this.run("/usr/bin/open", [path]);
          return {
            success: true,
            message: "Открыто: " + basename(path),
            data: { path },
          };
        }
        case "open_named_item":
          return this.openNamed(c.parameters, registry);
        case "open_url":
          await this.run("/usr/bin/open", [c.parameters.url]);
          return { success: true, message: "Открыт " + c.parameters.url };
        case "new_browser_tab": {
          const name = application(c.parameters.applicationId);
          if (c.parameters.applicationId !== "chrome")
            throw new Error("Новые вкладки пока поддерживаются для Google Chrome");
          await this.run("/usr/bin/open", ["-a", name]);
          await this.run("/usr/bin/osascript", [
            "-e",
            'tell application "Google Chrome"\n activate\n if (count of windows) is 0 then make new window\n tell front window to make new tab at after last tab\nend tell',
          ]);
          return { success: true, message: "Открыта новая вкладка в Chrome" };
        }
        case "search_files":
          return this.search(c.parameters);
        case "run_shortcut":
          if (!confirmed) throw new Error("Требуется подтверждение");
          await this.run("/usr/bin/shortcuts", [
            "run",
            this.o.trust.shortcuts.find(
              (s) => s.id === c.parameters.shortcutId,
            )!.name,
          ]);
          return { success: true, message: "Быстрая команда выполнена" };
        case "set_volume":
          await this.run("/usr/bin/osascript", [
            "-e",
            "on run argv\n set volume output volume (item 1 of argv as integer)\nend run",
            String(c.parameters.volume),
          ]);
          return {
            success: true,
            message: "Громкость " + c.parameters.volume + "%",
          };
        case "media_play_pause":
          if (!confirmed) throw new Error("Требуется подтверждение");
          await this.run("/usr/bin/osascript", [
            "-e",
            'tell application "Music" to playpause',
          ]);
          return {
            success: true,
            message: "Воспроизведение Music переключено",
          };
        case "take_screenshot": {
          if (!confirmed) throw new Error("Требуется подтверждение");
          const dir = resolve(this.o.dataDir, "screenshots");
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const path = join(dir, randomUUID() + ".png");
          await this.run("/usr/sbin/screencapture", ["-x", path]);
          return {
            success: true,
            message: "Снимок сохранён только на Mac",
            data: { path },
          };
        }
        case "get_battery_status":
          return {
            success: true,
            message: await this.run("/usr/bin/pmset", ["-g", "batt"]),
          };
        case "get_active_application": {
          const name = await this.run("/usr/bin/osascript", [
            "-e",
            'tell application "System Events" to get name of first application process whose frontmost is true',
          ]);
          return {
            success: true,
            message: "Активное приложение: " + name,
            data: { application: name },
          };
        }
        case "lock_screen":
          if (!confirmed) throw new Error("Требуется подтверждение");
          await this.run("/usr/bin/osascript", [
            "-e",
            'tell application "System Events" to keystroke "q" using {control down, command down}',
          ]);
          return {
            success: true,
            message: "Отправлена команда блокировки экрана",
          };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (
        /not authorized|not allowed|assistive|-1743|-1719|permission|denied|could not create image/i.test(
          message,
        )
      )
        return {
          success: false,
          message:
            "macOS не разрешила действие. Откройте Системные настройки → Конфиденциальность и безопасность. Разрешите терминалу/Node «Автоматизацию», «Универсальный доступ» или «Запись экрана» для снимков; для файлов проверьте «Файлы и папки». Затем перезапустите агент.",
        };
      return { success: false, message: message.slice(0, 1500) };
    }
  }
  private async mock(c: Action, registry: Registry): Promise<ExecutionResult> {
    if (c.action === "search_files") {
      const dir = resolve(this.o.dataDir, "mock-files");
      await mkdir(dir, { recursive: true });
      const names =
        c.parameters.kind === "presentation"
          ? ["Презентация Cascade.pptx", "Презентация продукта.pptx"]
          : ["Отчёт Cascade.pdf", "План проекта.pdf"];
      const files: FileMatch[] = [];
      for (const [i, name] of names.entries()) {
        const path = join(dir, name);
        await writeFile(path, "Mock fixture — no real document");
        files.push({
          id: randomUUID(),
          name,
          path,
          modifiedAt: new Date(Date.now() - i * 86400000).toISOString(),
        });
      }
      return {
        success: true,
        message: "Mock: найдены документы",
        files: c.parameters.latest ? [files[0]] : files,
      };
    }
    if (c.action === "open_file" || c.action === "open_folder")
      await guardPath(
        c.parameters.path,
        [...this.o.roots, resolve(this.o.dataDir, "mock-files")],
        c.action === "open_file" ? "file" : "folder",
      );
    const messages: Partial<Record<Action["action"], string>> = {
      open_project:
        "Открыт проект " +
        (c.action === "open_project"
          ? registry.projects.find((p) => p.id === c.parameters.projectId)?.name
          : ""),
      get_battery_status: "Заряд MacBook: 84% · от батареи",
      get_active_application: "Активное приложение: Cursor",
      open_file: "Документ открыт",
      open_named_item: "Файл или папка открыты",
      open_application: "Приложение открыто",
      set_volume: "Громкость изменена",
      open_url: "Сайт открыт",
      new_browser_tab: "Открыта новая вкладка",
      lock_screen: "Экран заблокирован",
      close_application: "Приложение закрыто",
    };
    return {
      success: true,
      message:
        "Mock: " +
        (messages[c.action] ?? "Действие " + c.action + " выполнено"),
      data: {
        mock: true,
        ...(c.action === "get_active_application"
          ? { application: "Cursor" }
          : {}),
      },
    };
  }
  private async openNamed(
    p: Extract<Action, { action: "open_named_item" }>["parameters"],
    registry: Registry,
  ): Promise<ExecutionResult> {
    const needle = p.query.replace(/[\\"*?]/g, " ").trim();
    if (needle.length < 2) throw new Error("Назовите папку или файл");
    const reveal = async (path: string, kind: "file" | "folder") => {
      const guarded = await guardPath(path, this.o.roots, kind);
      if (p.applicationId) {
        const app = registry.applications.find((a) => a.id === p.applicationId);
        if (!app) throw new Error("Приложение не зарегистрировано");
        await this.openEditor(app.name, app.path, { folder: guarded });
        return {
          success: true,
          message: "Открыто в " + app.name + ": " + basename(guarded),
          data: { path: guarded },
        };
      }
      await this.run("/usr/bin/open", [guarded]);
      return {
        success: true,
        message: "Открыто: " + basename(guarded),
        data: { path: guarded },
      };
    };
    if (p.kind !== "file") {
      const known = knownFolderPath(needle);
      if (known) {
        try {
          return await reveal(known, "folder");
        } catch {
          // Fall through to Spotlight if the well-known folder is outside ALLOWED_DIRECTORIES.
        }
      }
    }
    const typeFilter =
      p.kind === "folder" || p.applicationId
        ? ' && kMDItemContentType == "public.folder"'
        : p.kind === "file"
          ? ' && kMDItemContentType != "public.folder"'
          : "";
    const matches: string[] = [];
    for (const root of this.o.roots) {
      try {
        const dir = await guardPath(root, this.o.roots, "folder");
        const found = await this.run("/usr/bin/mdfind", [
          "-0",
          "-onlyin",
          dir,
          "(kMDItemFSName == \"*" +
            needle +
            '*"cd || kMDItemDisplayName == "*' +
            needle +
            '*"cd)' +
            typeFilter,
        ]);
        matches.push(...found.split("\0").filter(Boolean));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
    }
    const ranked = rankNamedMatches(matches, needle);
    const ordered: string[] = [];
    if (p.applicationId || p.kind === "folder") {
      for (const candidate of ranked) {
        try {
          if ((await stat(candidate)).isDirectory()) ordered.push(candidate);
        } catch {
          continue;
        }
      }
      if (!p.applicationId)
        for (const candidate of ranked)
          if (!ordered.includes(candidate)) ordered.push(candidate);
    } else ordered.push(...ranked);
    for (const candidate of ordered.length ? ordered : ranked) {
      try {
        const info = await stat(candidate);
        const kind = info.isDirectory() ? "folder" : "file";
        if (p.kind === "folder" && kind !== "folder") continue;
        if (p.kind === "file" && kind !== "file") continue;
        if (p.applicationId && kind !== "folder") continue;
        return await reveal(candidate, kind);
      } catch {
        continue;
      }
    }
    throw new Error(
      "Не найдено: " +
        needle +
        ". Проверьте название и что папка есть в разрешённых каталогах.",
    );
  }
  private async search(
    p: Extract<Action, { action: "search_files" }>["parameters"],
  ): Promise<ExecutionResult> {
    const needle = p.query.replace(/[\\"*?]/g, " ").trim();
    const nameFilter = 'kMDItemFSName == "*' + needle + '*"cd';
    const extensions = p.extension
      ? [p.extension]
      : p.kind === "pdf"
        ? ["pdf"]
        : p.kind === "presentation"
          ? ["ppt", "pptx", "key"]
          : [];
    const filter = extensions.length
      ? "(" +
        nameFilter +
        ") && (" +
        extensions.map((e) => 'kMDItemFSName == "*.' + e + '"cd').join(" || ") +
        ")"
      : nameFilter;
    const paths = new Set<string>();
    for (const root of this.o.roots) {
      try {
        const dir = await guardPath(root, this.o.roots, "folder");
        const found = await this.run("/usr/bin/mdfind", [
          "-0",
          "-onlyin",
          dir,
          filter,
        ]);
        for (const file of found.split("\0").filter(Boolean)) paths.add(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
    }
    if (paths.size > 3000)
      throw new Error(
        "Найдено слишком много файлов. Уточните часть имени или расширение.",
      );
    const files: FileMatch[] = [];
    for (const path of paths) {
      try {
        const actual = await guardPath(path, this.o.roots);
        const extension = extname(actual).slice(1).toLowerCase();
        if (!documentExtensions.has("." + extension)) continue;
        if (p.extension && extension !== p.extension.toLowerCase()) continue;
        if (p.kind === "pdf" && extension !== "pdf") continue;
        if (
          p.kind === "presentation" &&
          !["ppt", "pptx", "key"].includes(extension)
        )
          continue;
        if (
          needle &&
          !basename(actual).toLowerCase().includes(needle.toLowerCase())
        )
          continue;
        const info = await stat(actual);
        if (p.modifiedAfter && info.mtimeMs < Date.parse(p.modifiedAfter))
          continue;
        files.push({
          id: randomUUID(),
          name: basename(actual),
          path: actual,
          modifiedAt: info.mtime.toISOString(),
        });
      } catch {
        continue;
      }
    }
    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    const unique = files
      .filter((f, i) => files.findIndex((x) => x.path === f.path) === i)
      .slice(0, p.latest ? 1 : 10);
    return {
      success: true,
      message: unique.length
        ? "Найдено файлов: " + unique.length
        : "Подходящие файлы не найдены в разрешённых папках. Проверьте индекс Spotlight.",
      files: unique,
    };
  }
}
