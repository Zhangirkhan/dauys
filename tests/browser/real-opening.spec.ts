import { test, expect, chromium, devices } from "@playwright/test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("one tap and recorded speech open Google Chrome automatically", async ({
  request,
}) => {
  test.skip(
    process.env.RUN_REAL_OPENING_TESTS !== "1",
    "Opt-in: реально открывает Google Chrome.",
  );
  test.setTimeout(150000);
  const dir = await mkdtemp(join(tmpdir(), "voice-opening-test-"));
  const run = promisify(execFile);
  const { token } = JSON.parse(await readFile("data/agent-token.json", "utf8"));
  const scenarios = [
    { speech: "Открой голого храма", result: "Открыто: Google Chrome" },
  ];
  try {
    for (const [i, scenario] of scenarios.entries()) {
      const aiff = join(dir, `speech-${i}.aiff`),
        wav = join(dir, `speech-${i}.wav`);
      await run("/usr/bin/say", ["-v", "Milena", "-o", aiff, scenario.speech]);
      await run("ffmpeg", [
        "-v",
        "error",
        "-i",
        aiff,
        "-ar",
        "48000",
        "-ac",
        "1",
        wav,
      ]);
      const browser = await chromium.launch({
        executablePath:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        args: [
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          "--use-file-for-fake-audio-capture=" + wav,
        ],
      });
      try {
        const context = await browser.newContext({
          ...devices["iPhone 13"],
          permissions: ["microphone"],
        });
        const page = await context.newPage();
        const pairing = await request.post("/api/auth/pair/start", {
          headers: { Authorization: "Bearer " + token },
          data: { name: "Mac" },
        });
        expect(pairing.ok()).toBe(true);
        await page.goto("http://localhost:5173");
        await page
          .getByLabel("Код подключения")
          .fill((await pairing.json()).data.code);
        await expect(
          page.getByRole("button", { name: "Подключить" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Подключить" }).click();
        await expect(
          page.getByRole("button", { name: "Записать команду" }),
        ).toBeVisible();
        const runtime = await page.evaluate(() =>
          fetch("/api/runtime").then((r) => r.json()),
        );
        expect(runtime.data).toMatchObject({
          stt: "local",
          intent: "local",
          realActions: true,
        });
        const previousIds = await page.evaluate(async () => {
          const body = await fetch("/api/history").then((response) =>
            response.json(),
          );
          return body.data.map((item: { id: string }) => item.id);
        });
        await page
          .getByRole("button", { name: "Записать команду", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Остановить запись", exact: true }),
        ).toBeVisible();
        await page.waitForTimeout(2500);
        await page
          .getByRole("button", { name: "Остановить запись", exact: true })
          .click();
        const value = await page.evaluate(
          async ({ expected, previousIds }) => {
            const deadline = Date.now() + 60_000;
            while (Date.now() < deadline) {
              const body = await fetch("/api/history").then((response) =>
                response.json(),
              );
              const latest = body.data?.find(
                (item: { id: string }) => !previousIds.includes(item.id),
              );
              if (latest?.result?.message.includes(expected)) return latest;
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            throw new Error("Voice command timed out");
          },
          { expected: scenario.result, previousIds },
        );
        console.log("REAL VOICE:", value.text, "→", value.result.message);
        await page.screenshot({
          path: `test-results/real-voice-${i}.png`,
          fullPage: true,
        });
        await page.evaluate(async (id) => {
          await fetch("/api/devices/" + id, { method: "DELETE" });
        }, runtime.data.deviceId);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
