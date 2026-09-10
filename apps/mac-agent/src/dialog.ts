import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function quoteAppleScript(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function osascript(source: string, timeout = 300000) {
  const { stdout } = await exec("osascript", ["-e", source], { timeout });
  return stdout.trim();
}

export async function askBootstrapSecret() {
  try {
    return await osascript(
      `text returned of (display dialog "Введите секрет привязки Mac-агента (AGENT_BOOTSTRAP_SECRET с сервера)." with title "Рядом" default answer "" with hidden answer buttons {"Отмена", "Продолжить"} default button "Продолжить" cancel button "Отмена")`,
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
  void osascript(
    `display dialog "${quoteAppleScript(text)}" with title "Рядом" buttons {"Готово"} default button "Готово"`,
  ).catch(() => undefined);
}
