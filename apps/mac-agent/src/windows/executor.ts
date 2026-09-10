import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdir,
  writeFile,
  readdir,
  stat,
  readFile,
} from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  actionSchema,
  requiresConfirmation,
  type Action,
  type AllowedAction,
  type Registry,
  type ExecutionResult,
  type FileMatch,
} from "../../../../packages/shared/src/index.js";
import { guardPath, documentExtensions } from "../safety.js";
import {
  pickNamedMatch,
  rankNamedMatches,
  scoreNamedPath,
} from "../spoken-name.js";
import {
  CursorProjectIndex,
  allowedSshHosts,
  guardRemoteUri,
  type CursorProject,
} from "../cursor-projects.js";
import type { ExecutorOptions } from "../executor.js";
import { WINDOWS_SUPPORTED_ACTIONS } from "./actions.js";
import {
  ensureWindowsHelpers,
  helperPath,
  runFixedPs1,
} from "./protect.js";
import {
  knownFolderIdWindows,
  knownFolderPathWindows,
} from "./folders.js";
import {
  findLocalApp,
  loadLocalApps,
} from "./apps-store.js";
import {
  TRUSTED_SYSTEM_TARGETS,
  validateWindowsExecutable,
  type TrustedSystemId,
} from "./validate-exe.js";
import type { LocalApp } from "../../../../packages/shared/src/index.js";

const exec = promisify(execFile);

export type WinExecutorOptions = ExecutorOptions & {
  /** Local trust map applicationId → exe/system. Paths never come from phone/server. */
  localApps?: LocalApp[];
};

export class WinExecutor {
  private projects: CursorProjectIndex;
  private helpersDir = "";
  private localApps: LocalApp[];
  constructor(private o: WinExecutorOptions) {
    this.projects = new CursorProjectIndex({
      roots: o.roots.length ? o.roots : [homedir()],
    });
    this.localApps = o.localApps ?? [];
  }
  setLocalApps(apps: LocalApp[]) {
    this.localApps = apps;
  }
  supportedActions(): AllowedAction[] {
    const list = [...WINDOWS_SUPPORTED_ACTIONS] as AllowedAction[];
    if (!Object.keys(this.o.trust.processes).length)
      return list.filter((a) => a !== "run_shortcut");
    return list;
  }
  warmProjects() {
    return this.projects.warm();
  }
  private async helpers() {
    if (!this.helpersDir)
      this.helpersDir = await ensureWindowsHelpers(this.o.dataDir);
    return this.helpersDir;
  }
  private async run(file: string, args: string[], timeout = 15000) {
    const { stdout } = await exec(file, args, {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout.trim();
  }
  private async launch(file: string, args: string[]) {
    const child = spawn(file, args, {
      stdio: "ignore",
      detached: true,
      shell: false,
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  }
  private async openTarget(target: string, args = "") {
    const dir = await this.helpers();
    const script = helperPath(dir, "open-target.ps1");
    const psArgs = ["-Target", target];
    if (args) psArgs.push("-Arguments", args);
    await runFixedPs1(script, psArgs);
  }
  private async resolveApp(
    applicationId: string,
    registry: Registry,
  ): Promise<{ name: string; path: string; system?: TrustedSystemId }> {
    // Prefer local trust catalog (paths never accepted from server/phone registry).
    let local = findLocalApp(this.localApps, applicationId);
    if (!local && !this.localApps.length) {
      try {
        const file = await loadLocalApps(this.o.dataDir);
        this.localApps = file.apps;
        local = findLocalApp(this.localApps, applicationId);
      } catch {
        /* fall through */
      }
    }
    if (local) {
      if (!local.enabled)
        throw new Error("Приложение отключено в локальных настройках");
      if (local.kind === "system") {
        const t = TRUSTED_SYSTEM_TARGETS[local.id];
        return { name: local.name, path: t.launch, system: local.id };
      }
      const path = await validateWindowsExecutable(local.executable);
      return { name: local.name, path };
    }

    // Dev / mock fallback: registry path only when no local catalog entry and not standalone-strict
    const app = registry.applications.find((a) => a.id === applicationId);
    if (!app) throw new Error("Приложение не зарегистрировано локально");
    if (applicationId === "explorer") {
      return {
        name: app.name,
        path: TRUSTED_SYSTEM_TARGETS.explorer.launch,
        system: "explorer",
      };
    }
    if (applicationId === "settings") {
      return {
        name: app.name,
        path: TRUSTED_SYSTEM_TARGETS.settings.launch,
        system: "settings",
      };
    }
    if (!this.o.real) {
      return { name: app.name, path: app.path ?? "C:\\mock\\app.exe" };
    }
    throw new Error(
      "Нет локального пути для «" +
        app.name +
        "». Откройте настройки агента и выполните поиск приложений.",
    );
  }
  private processNameFromExe(exePath: string) {
    return basename(exePath).replace(/\.exe$/i, "");
  }
  private async findEditorCli(appPath: string) {
    const candidates = [
      join(appPath, "..", "resources", "app", "bin", "cursor.cmd"),
      join(appPath, "..", "resources", "app", "bin", "cursor"),
      join(appPath, "..", "resources", "app", "bin", "code.cmd"),
      join(dirnameOfExe(appPath), "bin", "cursor.cmd"),
      join(homedir(), "AppData", "Local", "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"),
      join(homedir(), "AppData", "Local", "Programs", "Microsoft VS Code", "bin", "code.cmd"),
    ];
    for (const c of candidates) {
      try {
        await access(c);
        return c;
      } catch {
        continue;
      }
    }
  }
  private async openEditor(
    appPath: string,
    options: { folder?: string; newWindow?: boolean } = {},
  ) {
    const cli = await this.findEditorCli(appPath);
    if (cli && (options.folder || options.newWindow)) {
      const args = [
        ...(options.newWindow ? ["-n"] : []),
        ...(options.folder ? [options.folder] : []),
      ];
      // .cmd must not use shell:true — spawn via cmd.exe /c with fixed /c and quoted path is risky.
      // Prefer the .exe next to resources if CLI is .cmd:
      if (/\.cmd$/i.test(cli)) {
        const exe = appPath;
        const exeArgs = [
          ...(options.newWindow ? ["-n"] : []),
          ...(options.folder ? [options.folder] : []),
        ];
        await this.launch(exe, exeArgs.length ? exeArgs : ["-n"]);
        return;
      }
      await this.launch(cli, args.length ? args : ["-n"]);
      return;
    }
    if (options.folder) {
      await this.launch(appPath, [options.folder]);
      return;
    }
    await this.launch(appPath, []);
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
      if (!this.supportedActions().includes(c.action))
        throw new Error(
          "Действие «" + c.action + "» не поддерживается Windows-агентом",
        );

      const application = (id: string) => {
        const app = registry.applications.find((a) => a.id === id);
        if (!app) throw new Error("Приложение не зарегистрировано");
        return app;
      };
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
      if (c.action === "open_url" && c.parameters.applicationId)
        application(c.parameters.applicationId);
      if (c.action === "open_project") {
        project(c.parameters.projectId);
        if (c.parameters.applicationId) application(c.parameters.applicationId);
      }

      if (c.action === "run_scenario") {
        if (!confirmed) throw new Error("Сценарий требует подтверждения");
        const p = project(c.parameters.projectId);
        const steps = p.scenarios[c.parameters.scenarioId];
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
              windowsHide: true,
              env: {
                PATH: process.env.PATH,
                USERPROFILE: process.env.USERPROFILE,
                SYSTEMROOT: process.env.SYSTEMROOT,
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

      if (c.action === "run_shortcut") {
        const proc = this.o.trust.processes[c.parameters.shortcutId];
        if (
          !this.o.trust.shortcuts.some((s) => s.id === c.parameters.shortcutId) ||
          !proc
        )
          throw new Error(
            "На Windows shortcut выполняется только из agent-trust.json (shortcuts + processes с тем же id). macOS Shortcuts не поддерживаются.",
          );
      }

      if (!this.o.real) return this.mock(c, registry);

      switch (c.action) {
        case "open_application": {
          const app = await this.resolveApp(
            c.parameters.applicationId,
            registry,
          );
          if (app.system === "explorer" || app.path === "explorer.exe") {
            await this.openTarget("explorer.exe");
            return { success: true, message: "Открыт Проводник" };
          }
          if (app.system === "settings") {
            await this.openTarget(TRUSTED_SYSTEM_TARGETS.settings.launch);
            return { success: true, message: "Открыты Параметры Windows" };
          }
          await this.openEditor(app.path, {
            newWindow: c.parameters.newWindow === true,
          });
          return {
            success: true,
            message: c.parameters.newWindow
              ? "Открыто новое окно: " + app.name
              : "Открыто: " + app.name,
          };
        }
        case "close_application": {
          if (!confirmed) throw new Error("Требуется подтверждение");
          const app = await this.resolveApp(
            c.parameters.applicationId,
            registry,
          );
          if (app.system)
            throw new Error("Системную цель нельзя закрыть этой командой");
          const dir = await this.helpers();
          const out = await runFixedPs1(helperPath(dir, "close-app.ps1"), [
            "-ProcessName",
            this.processNameFromExe(app.path),
          ]);
          if (out.includes("not_running"))
            return {
              success: true,
              message: "Приложение уже не запущено: " + app.name,
            };
          if (out.includes("needs_ui"))
            return {
              success: true,
              message:
                "Запрошено закрытие " +
                app.name +
                ". На компьютере может понадобиться сохранить документ.",
            };
          return {
            success: true,
            message:
              "Запрошено закрытие приложения. Несохранённый документ может требовать ответа на компьютере.",
          };
        }
        case "open_project": {
          const p = project(c.parameters.projectId);
          const folder = await guardPath(p.path, this.o.roots, "project");
          const appId =
            c.parameters.applicationId ??
            registry.applications.find((a) => a.name === p.defaultApplication)
              ?.id;
          if (!appId) throw new Error("Редактор не зарегистрирован");
          const app = await this.resolveApp(appId, registry);
          await this.openEditor(app.path, { folder });
          return { success: true, message: "Открыт проект " + p.name };
        }
        case "open_file":
        case "open_folder": {
          const path = await guardPath(
            c.parameters.path,
            this.o.roots,
            c.action === "open_file" ? "file" : "folder",
          );
          if (c.action === "open_folder")
            await this.launch("explorer.exe", [path]);
          else await this.openTarget(path);
          return {
            success: true,
            message: "Открыто: " + basename(path),
            data: { path },
          };
        }
        case "open_named_item":
          return this.openNamed(c.parameters, registry);
        case "open_editor_project":
          return this.openEditorProject(c.parameters, registry);
        case "open_url": {
          if (c.parameters.applicationId) {
            const app = await this.resolveApp(
              c.parameters.applicationId,
              registry,
            );
            await this.launch(app.path, [c.parameters.url]);
          } else {
            await this.launch("explorer.exe", [c.parameters.url]);
          }
          return { success: true, message: "Открыт " + c.parameters.url };
        }
        case "new_browser_tab": {
          const app = await this.resolveApp(
            c.parameters.applicationId,
            registry,
          );
          if (!/chrome|msedge|brave/i.test(app.name + app.path))
            throw new Error(
              "Новая вкладка на Windows поддерживается для Chrome / Edge / Brave с путём к .exe",
            );
          // Не гарантируем «новую вкладку» во всех состояниях браузера —
          // передаём явный флаг браузеру.
          await this.launch(app.path, ["--new-tab", "about:blank"]);
          return {
            success: true,
            message:
              "Отправлена команда новой вкладки в " +
              app.name +
              " (браузер может сфокусировать уже открытое окно).",
          };
        }
        case "search_files":
          return this.search(c.parameters);
        case "run_shortcut": {
          if (!confirmed) throw new Error("Требуется подтверждение");
          const proc = this.o.trust.processes[c.parameters.shortcutId]!;
          const cwd = await guardPath(proc.cwd, this.o.roots, "project");
          const child = spawn(proc.executable, proc.args, {
            cwd,
            stdio: "ignore",
            detached: true,
            shell: false,
            windowsHide: true,
          });
          await new Promise<void>((res, rej) => {
            child.once("spawn", res);
            child.once("error", rej);
          });
          child.unref();
          return {
            success: true,
            message:
              "Локальное действие выполнено: " +
              (this.o.trust.shortcuts.find(
                (s) => s.id === c.parameters.shortcutId,
              )?.name ?? c.parameters.shortcutId),
          };
        }
        case "set_volume": {
          const dir = await this.helpers();
          await runFixedPs1(helperPath(dir, "set-volume.ps1"), [
            "-Volume",
            String(c.parameters.volume),
          ]);
          return {
            success: true,
            message: "Громкость ≈ " + c.parameters.volume + "%",
          };
        }
        case "media_play_pause": {
          if (!confirmed) throw new Error("Требуется подтверждение");
          const dir = await this.helpers();
          await runFixedPs1(helperPath(dir, "media-playpause.ps1"), []);
          return {
            success: true,
            message: "Отправлена медиа-клавиша play/pause",
          };
        }
        case "take_screenshot": {
          if (!confirmed) throw new Error("Требуется подтверждение");
          const dir = resolve(this.o.dataDir, "screenshots");
          await mkdir(dir, { recursive: true });
          const path = join(dir, randomUUID() + ".png");
          const helpers = await this.helpers();
          await runFixedPs1(helperPath(helpers, "screenshot.ps1"), [
            "-OutPath",
            path,
          ]);
          return {
            success: true,
            message: "Снимок сохранён только на компьютере",
            data: { path },
          };
        }
        case "get_battery_status": {
          const dir = await this.helpers();
          const out = await runFixedPs1(helperPath(dir, "battery.ps1"), []);
          if (out === "no_battery")
            return {
              success: true,
              message: "Батарея не обнаружена (стационарный ПК)",
            };
          return { success: true, message: out };
        }
        case "get_active_application": {
          const dir = await this.helpers();
          const out = await runFixedPs1(helperPath(dir, "foreground.ps1"), []);
          const [name, title] = out.split("|");
          return {
            success: true,
            message:
              "Активное приложение: " +
              (name || "неизвестно") +
              (title ? " — " + title : ""),
            data: { application: name || title || "" },
          };
        }
        case "lock_screen": {
          if (!confirmed) throw new Error("Требуется подтверждение");
          // Фиксированный вызов: executable + entry point без пользовательских данных
          await this.run("rundll32.exe", ["user32.dll,LockWorkStation"]);
          return {
            success: true,
            message: "Отправлена команда блокировки экрана",
          };
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, message: message.slice(0, 1500) };
    }
  }
  private async mock(c: Action, _registry: Registry): Promise<ExecutionResult> {
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
    return {
      success: true,
      message: "Mock: действие " + c.action + " выполнено",
      data: { mock: true, platform: "win32" },
    };
  }
  private editorApp(registry: Registry, applicationId?: string) {
    const app = applicationId
      ? registry.applications.find((a) => a.id === applicationId)
      : (registry.applications.find((a) => a.id === "cursor") ??
        registry.applications.find((a) =>
          /cursor|visual studio code|code/i.test(a.name),
        ));
    if (!app) throw new Error("Редактор не зарегистрирован");
    return app;
  }
  private async launchProject(
    project: CursorProject,
    app: { name: string; path?: string },
    newWindow: boolean,
  ) {
    if (!app.path)
      throw new Error("Для Windows укажите путь к .exe редактора");
    if (project.local) {
      const folder = await guardPath(project.path, this.o.roots, "project");
      await this.openEditor(app.path, { folder, newWindow });
      return;
    }
    let config = "";
    try {
      config = await readFile(join(homedir(), ".ssh", "config"), "utf8");
    } catch {
      config = "";
    }
    guardRemoteUri(
      project.uri,
      allowedSshHosts(config, process.env.ALLOWED_SSH_HOSTS ?? ""),
    );
    await this.launch(app.path, [
      ...(newWindow ? ["-n"] : []),
      "--folder-uri",
      project.uri,
    ]);
  }
  private async openEditorProject(
    p: Extract<Action, { action: "open_editor_project" }>["parameters"],
    registry: Registry,
  ): Promise<ExecutionResult> {
    const app = this.editorApp(registry, p.applicationId);
    const matches = p.projectKey
      ? [await this.projects.byKey(p.projectKey)].filter(
          (project): project is CursorProject => !!project,
        )
      : await this.projects.find(p.query, p.host);
    if (!matches.length) {
      if (!p.query)
        throw new Error("Проект из списка больше не доступен, повторите запрос");
      return this.openNamed(
        { query: p.query, kind: "folder", applicationId: app.id },
        registry,
      );
    }
    if (matches.length > 1 && !p.projectKey)
      return {
        success: true,
        message: "Нашлось несколько проектов. Назовите номер.",
        files: matches.slice(0, 10).map((project) => ({
          id: project.key,
          name: project.name,
          path: project.path,
          modifiedAt: new Date().toISOString(),
          kind: "project" as const,
          ...(project.host ? { host: project.host } : {}),
        })),
      };
    const project = matches[0];
    await this.launchProject(project, app, p.newWindow === true);
    return {
      success: true,
      message:
        "Открываю " +
        project.name +
        (project.host ? " на " + project.host : "") +
        " в " +
        app.name,
      data: { path: project.path, uri: project.uri },
    };
  }
  private async openNamed(
    p: Extract<Action, { action: "open_named_item" }>["parameters"],
    registry: Registry,
  ): Promise<ExecutionResult> {
    const needle = p.query.replace(/[\\"*?]/g, " ").trim();
    if (!needle) throw new Error("Назовите папку или файл");
    const reveal = async (path: string, kind: "file" | "folder") => {
      const guarded = await guardPath(path, this.o.roots, kind);
      if (p.applicationId) {
        const app = await this.resolveApp(p.applicationId, registry);
        await this.openEditor(app.path, { folder: guarded });
        return {
          success: true,
          message: "Открыто в " + app.name + ": " + basename(guarded),
          data: { path: guarded },
        };
      }
      if (kind === "folder") await this.launch("explorer.exe", [guarded]);
      else await this.openTarget(guarded);
      return {
        success: true,
        message: "Открыто: " + basename(guarded),
        data: { path: guarded },
      };
    };
    if (p.kind !== "file") {
      const knownId = knownFolderIdWindows(needle);
      if (knownId) {
        try {
          const helpers = await this.helpers();
          const known =
            (await runFixedPs1(helperPath(helpers, "known-folder.ps1"), [
              "-Id",
              knownId,
            ])) || knownFolderPathWindows(needle);
          if (known) return await reveal(known, "folder");
        } catch {
          /* fall through */
        }
      }
    }
    const walked = await this.walkNamedFallback();
    const typed = await this.filterNamedKind(walked, p);
    const pick = pickNamedMatch(typed, needle, p.kind);
    if (pick.type === "choose") {
      const files = await this.namedChoices(pick.paths);
      if (files.length === 1)
        return await reveal(
          files[0].path,
          files[0].kind === "folder" ? "folder" : "file",
        );
      if (files.length > 1)
        return {
          success: true,
          message: "Нашлось несколько вариантов. Назовите номер.",
          files,
        };
    }
    const ordered =
      pick.type === "open"
        ? [pick.path, ...rankNamedMatches(typed, needle, p.kind)]
        : rankNamedMatches(typed, needle, p.kind);
    for (const candidate of ordered) {
      try {
        if (scoreNamedPath(candidate, needle, p.kind) < 50) continue;
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
  private async filterNamedKind(
    paths: string[],
    p: Extract<Action, { action: "open_named_item" }>["parameters"],
  ) {
    const out: string[] = [];
    for (const path of [...new Set(paths)]) {
      try {
        const info = await stat(path);
        const kind = info.isDirectory() ? "folder" : "file";
        if (p.kind === "folder" && kind !== "folder") continue;
        if (p.kind === "file" && kind !== "file") continue;
        if (p.applicationId && kind !== "folder") continue;
        out.push(path);
      } catch {
        continue;
      }
    }
    return out;
  }
  private async namedChoices(paths: string[]): Promise<FileMatch[]> {
    const files: FileMatch[] = [];
    for (const path of paths) {
      try {
        const actual = await guardPath(
          path,
          this.o.roots,
          (await stat(path)).isDirectory() ? "folder" : "file",
        );
        const info = await stat(actual);
        files.push({
          id: randomUUID(),
          name: basename(actual),
          path: actual,
          modifiedAt: info.mtime.toISOString(),
          kind: info.isDirectory() ? "folder" : "file",
        });
      } catch {
        continue;
      }
    }
    return files;
  }
  private async walkNamedFallback() {
    const SKIP =
      /^(node_modules|\.git|\.venv|dist|build|AppData|Application Data|\$RECYCLE\.BIN|System Volume Information)$/i;
    const found: string[] = [];
    const walk = async (dir: string, depth: number, maxDepth: number) => {
      if (depth > maxDepth || found.length >= 2000) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= 2000) return;
        if (entry.name.startsWith(".")) continue;
        const path = join(dir, entry.name);
        found.push(path);
        if (
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          depth < maxDepth &&
          !SKIP.test(entry.name)
        )
          await walk(path, depth + 1, maxDepth);
      }
    };
    const home = homedir();
    for (const name of [
      "Desktop",
      "Documents",
      "Downloads",
      "Pictures",
      "Videos",
      "Music",
      "source",
      "projects",
      "dev",
    ]) {
      try {
        const dir = join(home, name);
        await guardPath(dir, this.o.roots, "folder");
        await walk(dir, 0, 4);
      } catch {
        continue;
      }
    }
    for (const root of this.o.roots) {
      try {
        const dir = await guardPath(root, this.o.roots, "folder");
        await walk(dir, 0, 3);
      } catch {
        continue;
      }
    }
    return found;
  }
  private async search(
    p: Extract<Action, { action: "search_files" }>["parameters"],
  ): Promise<ExecutionResult> {
    const needle = p.query.replace(/[\\"*?]/g, " ").trim().toLowerCase();
    const paths = await this.walkNamedFallback();
    const files: FileMatch[] = [];
    for (const path of paths) {
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        const actual = await guardPath(path, this.o.roots);
        const extension = extname(actual).slice(1).toLowerCase();
        if (!documentExtensions.has("." + extension)) continue;
        if (p.extension && extension !== p.extension.toLowerCase()) continue;
        if (p.kind === "pdf" && extension !== "pdf") continue;
        if (
          p.kind === "presentation" &&
          !["ppt", "pptx"].includes(extension)
        )
          continue;
        if (needle && !basename(actual).toLowerCase().includes(needle))
          continue;
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
        : "Подходящие файлы не найдены в разрешённых папках.",
      files: unique,
    };
  }
}

function dirnameOfExe(exePath: string) {
  return resolve(exePath, "..");
}
