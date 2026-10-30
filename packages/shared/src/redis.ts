import { Redis, type RedisOptions } from "ioredis";
import type { Logger } from "pino";

// Stage 2 (backend spec, section 14). Redis is shared infrastructure, never the source of
// truth: anything in it can disappear and the worst case is a cache miss or a missed push.
export function createRedis(url: string, logger: Logger, options: RedisOptions = {}): Redis {
  const redis = new Redis(url, options);
  // ioredis reconnects by itself; without a listener, a dropped connection would crash
  // the process with an unhandled 'error' event.
  redis.on("error", (err) => logger.warn({ err: err.message }, "redis error"));
  return redis;
}

export type { Redis };
