import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  copyFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
export function setupEnv() {
  mkdirSync("data", { recursive: true, mode: 0o700 });
  if (!existsSync(".env")) {
    const template = readFileSync(".env.example", "utf8");
    writeFileSync(
      ".env",
      template.replace(
        "AGENT_BOOTSTRAP_SECRET=",
        "AGENT_BOOTSTRAP_SECRET=" + randomBytes(32).toString("hex"),
      ),
      { mode: 0o600 },
    );
    console.log("Создан .env для mock-режима.");
  } else {
    let text = readFileSync(".env", "utf8");
    if (!/^AGENT_BOOTSTRAP_SECRET=/m.test(text)) {
      text += "\nAGENT_BOOTSTRAP_SECRET=\n";
      writeFileSync(".env", text, { mode: 0o600 });
    }
    if (/^AGENT_BOOTSTRAP_SECRET=\s*$/m.test(text))
      writeFileSync(
        ".env",
        text.replace(
          /^AGENT_BOOTSTRAP_SECRET=\s*$/m,
          "AGENT_BOOTSTRAP_SECRET=" + randomBytes(32).toString("hex"),
        ),
        { mode: 0o600 },
      );
    chmodSync(".env", 0o600);
  }
  for (const name of ["registry", "agent-trust"])
    if (!existsSync("data/" + name + ".json"))
      copyFileSync(
        "config/" + name + ".example.json",
        "data/" + name + ".json",
      );
}
if (process.argv[1]?.endsWith("setup-env.mjs")) setupEnv();
