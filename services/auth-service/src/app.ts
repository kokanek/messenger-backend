import { createApp, finishApp, type Logger, type Redis } from "@messenger/shared";
import type { Pool } from "pg";
import type { AuthConfig } from "./config.js";
import type { AuthMetrics } from "./metrics.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import type { UserListCache } from "./user-cache.js";

export interface AppDeps {
  pool: Pool;
  config: AuthConfig;
  logger: Logger;
  // Stage 2. Without them (as in the tests), the user list is read from Postgres every time.
  userCache?: UserListCache;
  redis?: Redis; // only checked by /ready
  // Module 5. Without it (as in most tests), no /metrics route and nothing is counted.
  metrics?: AuthMetrics;
}

export function createAuthApp(deps: AppDeps) {
  const app = createApp({
    logger: deps.logger,
    allowedOrigins: deps.config.ALLOWED_ORIGINS,
    readiness: {
      postgres: () => deps.pool.query("SELECT 1"),
      ...(deps.redis ? { redis: () => deps.redis!.ping() } : {}),
    },
    metrics: deps.metrics,
  });
  app.use(authRoutes(deps));
  app.use(userRoutes(deps));
  return finishApp(app);
}
