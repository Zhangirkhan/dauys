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
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
  expect(
    manifest.icons.some((icon: { sizes: string }) => icon.sizes === "192x192"),
  ).toBe(true);
  expect(
    manifest.icons.some((icon: { sizes: string }) => icon.sizes === "512x512"),
  ).toBe(true);
  const icon = await page.request.get("/icon-192.png");
  expect(icon.headers()["content-type"]).toContain("image/png");
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
  await expect(
    page.getByRole("button", { name: "Скачать приложение" }),
  ).toBeVisible();
});
