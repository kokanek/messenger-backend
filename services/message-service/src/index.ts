import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { connectWithRetry, createLogger, createRedis, handleShutdown, runMigrations } from "@messenger/shared";
import pg from "pg";
import { createMessageApp } from "./app.js";
import { RedisBroadcaster } from "./broadcaster.js";
import { loadMessageConfig } from "./config.js";
import { Registry } from "./ws/registry.js";
import { attachWebSocketServer } from "./ws/server.js";

const config = loadMessageConfig();
const logger = createLogger("message-service", config.LOG_LEVEL);
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

const publisher = createRedis(config.REDIS_URL, logger);
const subscriber = createRedis(config.REDIS_URL, logger);

await connectWithRetry("postgres", () => pool.query("SELECT 1"), logger);
await connectWithRetry("redis", () => publisher.ping(), logger);
await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)), 4003, logger);

const registry = new Registry();
const broadcaster = new RedisBroadcaster(publisher, subscriber, registry);
const server = createServer(createMessageApp({ pool, config, logger, broadcaster, redis: publisher }));
const sockets = attachWebSocketServer({
  server,
  registry,
  broadcaster,
  jwtSecret: config.JWT_SECRET,
  allowedOrigins: config.ALLOWED_ORIGINS,
  logger,
});

server.listen(config.PORT, () => logger.info({ port: config.PORT }, "message-service listening"));

handleShutdown({
  server,
  logger,
  beforeDrain: () => sockets.closeAll(),
  close: async () => {
    await Promise.all([pool.end(), publisher.quit(), subscriber.quit()]);
  },
});
