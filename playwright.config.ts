import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export default defineConfig({
  testDir: "tests/browser",
  timeout: 90000,
  workers: 1,
  use: {
    baseURL: process.env.BROWSER_BASE_URL ?? "http://localhost:5173",
    ...devices["iPhone 13"],
    defaultBrowserType: "chromium",
    permissions: ["microphone"],
    launchOptions: {
      ...(existsSync(chrome) ? { executablePath: chrome } : {}),
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
    trace: "retain-on-failure",
  },
  reporter: "list",
});
