import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentDataDir } from "./paths.js";
import {
  ensureWindowsHelpers,
  runFixedPs1,
  helperPath,
} from "./windows/protect.js";
import {
  bootStageStart,
  bootStageDone,
  bootStageFail,
} from "./boot-log.js";

const exec = promisify(execFile);

export function quoteAppleScript(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function osascript(source: string, timeout = 300000) {
  const { stdout } = await exec("osascript", ["-e", source], { timeout });
  return stdout.trim();
}

export async function askBootstrapSecret() {
  if (process.platform === "win32") {
    bootStageStart("dialog.askBootstrapSecret", {
      note: "ожидание InputBox; окно должно быть видимым",
    });
    try {
      bootStageStart("dialog.ensureHelpers");
      const helpers = await ensureWindowsHelpers(agentDataDir());
      bootStageDone("dialog.ensureHelpers");
      const value = await runFixedPs1(
        helperPath(helpers, "input-box.ps1"),
        [
          "-Title",
          "Рядом",
          "-Prompt",
          "Введите секрет привязки агента (AGENT_BOOTSTRAP_SECRET с сервера).",
        ],
        { interactive: true, timeout: 300_000 },
      );
      bootStageDone("dialog.askBootstrapSecret", {
        received: value.length > 0,
      });
      return value;
    } catch (e) {
      bootStageFail("dialog.askBootstrapSecret", e);
      throw new Error(
        "Нужен AGENT_BOOTSTRAP_SECRET: задайте переменную окружения или введите в диалоге.",
      );
    }
  }
  try {
    return await osascript(
      `text returned of (display dialog "Введите секрет привязки агента (AGENT_BOOTSTRAP_SECRET с сервера)." with title "Рядом" default answer "" with hidden answer buttons {"Отмена", "Продолжить"} default button "Продолжить" cancel button "Отмена")`,
    );
  } catch {
    throw new Error(
      "Нужен AGENT_BOOTSTRAP_SECRET: задайте переменную окружения или введите в диалоге.",
    );
  }
}

export function showPairingCode(code: string, pwaUrl: string) {
  const text = `Код для телефона: ${code}

Откройте ${pwaUrl} и введите этот код.
Действует 5 минут.`;
  if (process.platform === "win32") {
    void (async () => {
      bootStageStart("dialog.showPairingCode");
      try {
        const helpers = await ensureWindowsHelpers(agentDataDir());
        await runFixedPs1(
          helperPath(helpers, "message-box.ps1"),
          ["-Title", "Рядом", "-Prompt", text],
          { interactive: true, timeout: 300_000 },
        );
        bootStageDone("dialog.showPairingCode");
      } catch (e) {
        bootStageFail("dialog.showPairingCode", e);
      }
    })();
    return;
  }
  void osascript(
    `display dialog "${quoteAppleScript(text)}" with title "Рядом" buttons {"Готово"} default button "Готово"`,
  ).catch(() => undefined);
}
