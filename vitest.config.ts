import { defineConfig } from "vitest/config";

// One project per workspace, plus the end-to-end tests. `npm test` runs every project
// except e2e; `npm run test:e2e` runs only e2e (it needs the full stack on :8080).
const workspace = (name: string, root: string) => ({
  extends: true as const,
  test: { name, root, include: ["test/**/*.test.ts"], globalSetup: ["../../test/wait-for-databases.ts"] },
});

export default defineConfig({
  resolve: { conditions: ["development"] },
  ssr: { resolve: { conditions: ["development"] } },
  test: {
    // Integration tests in one service share one test database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    projects: [
      workspace("shared", "packages/shared"),
      workspace("auth-service", "services/auth-service"),
      workspace("message-service", "services/message-service"),
      workspace("conversation-service", "services/conversation-service"),
      { extends: true, test: { name: "e2e", include: ["test/e2e/**/*.test.ts"] } },
    ],
  },
});
