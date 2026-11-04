import { createApp, finishApp, type Logger, type Redis } from "@messenger/shared";
import type { Pool } from "pg";
import type { Broadcaster } from "./broadcaster.js";
import type { MessageConfig } from "./config.js";
import type { MessageMetrics } from "./metrics.js";
import { internalRoutes } from "./routes/internal.js";
import { messageRoutes } from "./routes/messages.js";

export interface AppDeps {
  pool: Pool;
  config: MessageConfig;
  logger: Logger;
  broadcaster: Broadcaster;
  redis?: Redis; // only checked by /ready
  // Module 5. Without it (as in most tests), no /metrics route and nothing is counted.
  metrics?: MessageMetrics;
}

export function createMessageApp(deps: AppDeps) {
  const app = createApp({
    logger: deps.logger,
    allowedOrigins: deps.config.ALLOWED_ORIGINS,
    readiness: {
      postgres: () => deps.pool.query("SELECT 1"),
      ...(deps.redis ? { redis: () => deps.redis!.ping() } : {}),
    },
    metrics: deps.metrics,
  });
  app.use(messageRoutes(deps));
  app.use(internalRoutes(deps));
  return finishApp(app);
}
