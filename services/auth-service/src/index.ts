import { fileURLToPath } from "node:url";
import { connectWithRetry, createLogger, createRedis, handleShutdown, runMigrations } from "@messenger/shared";
import pg from "pg";
import { createAuthApp } from "./app.js";
import { ensureAdmin } from "./bootstrap.js";
import { loadAuthConfig } from "./config.js";
import { createAuthMetrics } from "./metrics.js";
import { UserListCache } from "./user-cache.js";

const config = loadAuthConfig();
const logger = createLogger("auth-service", config.LOG_LEVEL);
const metrics = createAuthMetrics();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
// Only a cache: fail fast when Redis is down instead of queueing commands, so requests
// fall back to Postgres at once.
const redis = createRedis(config.REDIS_URL, logger, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });

await connectWithRetry("postgres", () => pool.query("SELECT 1"), logger);
await connectWithRetry("redis", () => redis.ping(), logger);
await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)), 4001, logger);
await ensureAdmin(pool, config.ADMIN_USERNAME, config.ADMIN_PASSWORD, logger);

const userCache = new UserListCache(redis, logger, metrics.userCache);
const server = createAuthApp({ pool, config, logger, userCache, redis, metrics }).listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "auth-service listening");
});

handleShutdown({
  server,
  logger,
  close: async () => {
    await Promise.all([pool.end(), redis.quit()]);
  },
});
