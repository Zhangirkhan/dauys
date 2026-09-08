import { test, expect } from "@playwright/test";

test("production manifest, service worker and offline shell", async ({
  page,
  context,
}) => {
  await page.goto("http://localhost:8787");
  const manifest = await page.evaluate(async () => {
    const response = await fetch("/manifest.webmanifest");
    return response.json();
  });
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons).toHaveLength(2);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(
    true,
  );
  const urls = await page.evaluate(async () => {
    const entries = await Promise.all(
      (await caches.keys()).map(async (key) => {
        const cache = await caches.open(key);
        return (await cache.keys()).map((request) => request.url);
      }),
    );
    return entries.flat();
  });
  expect(urls.some((url) => url.includes("/api/"))).toBe(false);
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: /Записать команду|Подключить/ }),
  ).toBeVisible();
});
