import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const localMacChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const launchOptions = existsSync(localMacChrome)
  ? { executablePath: localMacChrome }
  : undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4179",
    headless: true,
    launchOptions,
    trace: "off"
  },
  webServer: {
    command: "npm run build:demo && npx vite preview --host 127.0.0.1 --port 4179",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 30_000
  }
});
