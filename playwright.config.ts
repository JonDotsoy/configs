import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// This repo's dev sandbox pre-installs Chromium outside Playwright's own
// managed cache; CI (and a plain `bunx playwright install`) don't have that
// path, so fall back to Playwright's own resolution when it's absent.
const sandboxChromium = "/opt/pw-browsers/chromium";
const executablePath = existsSync(sandboxChromium) ? sandboxChromium : undefined;

export default defineConfig({
  testDir: "./test/browser",
  // ".pw.ts" instead of ".spec.ts" so `bun test`'s default globbing (which
  // picks up *.spec.ts) never tries to load a Playwright test with bun:test.
  testMatch: "**/*.pw.ts",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  webServer: {
    command: "bun run test/browser/server.ts",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
  ],
});
