import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("single-button interface records until stop then executes", async ({
  page,
  request,
}) => {
  const configured = await readFile(".env", "utf8");
  test.skip(
    /^ALLOW_REAL_MAC_ACTIONS=true$/m.test(configured) ||
      /^STT_PROVIDER=(?:local|parakeet)$/m.test(configured),
    "Mock-only browser scenario",
  );
  const { token } = JSON.parse(await readFile("data/agent-token.json", "utf8"));
  const pairing = await request.post("/api/auth/pair/start", {
    headers: { Authorization: "Bearer " + token },
    data: { name: "Mac" },
  });
  await page.goto("/");
  await page
    .getByLabel("Код подключения")
    .fill((await pairing.json()).data.code);
  await page.getByRole("button", { name: "Подключить" }).click();
  const record = page.getByRole("button", { name: "Записать команду" });
  await expect(record).toBeVisible();
  await expect(page.locator("main button")).toHaveCount(1);
  await expect(page.locator("main")).not.toContainText(/./);
  await record.click();
  const stop = page.getByRole("button", { name: "Остановить запись" });
  await expect(stop).toBeVisible();
  await page.waitForTimeout(800);
  await stop.click();
  await expect(record).toBeVisible({ timeout: 25_000 });
  await page.waitForFunction(async () => {
    const body = await fetch("/api/history").then((response) =>
      response.json(),
    );
    return body.data?.[0]?.status === "done";
  });
  await expect(page.locator(".session-history li")).toHaveCount(1);
});
