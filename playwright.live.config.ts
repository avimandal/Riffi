import { defineConfig, devices } from '@playwright/test';

/**
 * Live accuracy run against a real AI provider (not part of CI):
 *   GEMINI_API_KEY=… npx playwright test -c playwright.live.config.ts
 * The key is only ever passed to the local PHP server through the environment.
 */
export default defineConfig({
  testDir: 'tests/live',
  timeout: 45 * 60_000,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5174',
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
