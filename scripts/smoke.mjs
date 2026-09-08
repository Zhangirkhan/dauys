import { readFile } from "node:fs/promises";
import "dotenv/config";
const base = process.env.SERVER_PUBLIC_URL ?? "http://localhost:8787";
const health = await fetch(base + "/health");
if (!health.ok) throw new Error("Health failed");
const { token } = JSON.parse(
  await readFile(
    process.env.AGENT_TOKEN_PATH ?? "data/agent-token.json",
    "utf8",
  ),
);
const pair = await fetch(base + "/api/auth/pair/start", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name: "Smoke Mac" }),
});
const pairing = await pair.json();
if (!pair.ok) throw new Error(JSON.stringify(pairing));
const session = await fetch(base + "/api/auth/pair/complete", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: base },
  body: JSON.stringify({ code: pairing.data.code, name: "Smoke test" }),
});
const cookie = session.headers.get("set-cookie")?.split(";")[0];
const device = await session.json();
if (!session.ok || !cookie) throw new Error("Pairing failed");
const headers = {
  Cookie: cookie,
  Origin: base,
  "Content-Type": "application/json",
};
const response = await fetch(base + "/api/text-command", {
  method: "POST",
  headers,
  body: JSON.stringify({ text: "Давай поработаем над OTP" }),
});
const body = await response.json();
if (!response.ok) throw new Error(JSON.stringify(body));
for (let i = 0; i < 50; i++) {
  const result = await fetch(base + "/api/commands/" + body.data.id, {
    headers,
  }).then((r) => r.json());
  if (result.data.status === "done") {
    console.log(
      JSON.stringify(
        {
          health: "ok",
          command: result.data.command,
          result: result.data.result,
        },
        null,
        2,
      ),
    );
    await fetch(base + "/api/devices/" + device.data.deviceId, {
      method: "DELETE",
      headers,
    });
    process.exit(0);
  }
  if (result.data.status === "error")
    throw new Error(result.data.result.message);
  await new Promise((r) => setTimeout(r, 100));
}
throw new Error("Command timed out");
