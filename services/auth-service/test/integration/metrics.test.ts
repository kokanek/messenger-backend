import { fileURLToPath } from "node:url";
import { createRedis, runMigrations } from "@messenger/shared";
import { pino } from "pino";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthApp } from "../../src/app.js";
import { ensureAdmin } from "../../src/bootstrap.js";
import { loadAuthConfig } from "../../src/config.js";
import { createAuthMetrics, type AuthMetrics } from "../../src/metrics.js";
import { UserListCache } from "../../src/user-cache.js";

const DATABASE_URL = process.env.AUTH_TEST_DATABASE_URL ?? "postgres://auth_svc:auth-dev@localhost:5432/auth_test";
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1";
const logger = pino({ level: "silent" });
const config = loadAuthConfig({
  JWT_SECRET: "test-secret-that-is-at-least-32-characters",
  ALLOWED_ORIGINS: "http://localhost:5180",
  DATABASE_URL,
  REDIS_URL,
});
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const redis = createRedis(REDIS_URL, logger, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
// Nothing listens on this port: stands in for Redis being down.
const deadRedis = createRedis("redis://127.0.0.1:6399", logger, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
});

// The value of one labelled series, 0 if it was never incremented.
async function valueOf(counter: AuthMetrics["logins"], result: string): Promise<number> {
  const { values } = await counter.get();
  return values.find((v) => v.labels.result === result)?.value ?? 0;
}

beforeAll(async () => {
  await pool.query("DROP TABLE IF EXISTS clients, users, schema_migrations CASCADE");
  await runMigrations(pool, fileURLToPath(new URL("../../migrations", import.meta.url)), 4001, logger);
  await ensureAdmin(pool, "admin", "admin-password", logger);
  await redis.ping();
});
afterAll(async () => {
  await Promise.all([pool.end(), redis.quit()]);
  deadRedis.disconnect();
});

describe("auth-service metrics", () => {
  it("M1: messenger_logins_total counts successes and wrong passwords", async () => {
    const metrics = createAuthMetrics();
    const app = createAuthApp({ pool, config, logger, metrics });

    await request(app).post("/api/auth/login").send({ username: "admin", password: "wrong" }).expect(401);
    await request(app).post("/api/auth/login").send({ username: "nobody", password: "wrong" }).expect(401);
    await request(app).post("/api/auth/login").send({ username: "admin", password: "admin-password" }).expect(200);

    expect(await valueOf(metrics.logins, "invalid_credentials")).toBe(2);
    expect(await valueOf(metrics.logins, "success")).toBe(1);
    const text = (await request(app).get("/metrics").expect(200)).text;
    expect(text).toContain('messenger_logins_total{result="success",service="auth-service"} 1');
  });

  it("M2: messenger_user_cache_requests_total counts a miss, then a hit, and an error when Redis is down", async () => {
    await redis.del("cache:users");
    const metrics = createAuthMetrics();
    const app = createAuthApp({
      pool,
      config,
      logger,
      metrics,
      userCache: new UserListCache(redis, logger, metrics.userCache),
    });
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin-password" });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    await request(app).get("/api/users").set(auth).expect(200); // miss, then fills the cache
    await request(app).get("/api/users").set(auth).expect(200); // hit
    expect(await valueOf(metrics.userCache, "miss")).toBe(1);
    expect(await valueOf(metrics.userCache, "hit")).toBe(1);

    const down = createAuthApp({
      pool,
      config,
      logger,
      userCache: new UserListCache(deadRedis, logger, metrics.userCache),
    });
    await request(down).get("/api/users").set(auth).expect(200); // falls back to Postgres
    expect(await valueOf(metrics.userCache, "error")).toBe(1);
  });
});
