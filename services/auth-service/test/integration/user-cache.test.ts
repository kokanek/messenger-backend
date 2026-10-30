import { fileURLToPath } from "node:url";
import { createRedis, runMigrations } from "@messenger/shared";
import { pino } from "pino";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthApp } from "../../src/app.js";
import { ensureAdmin } from "../../src/bootstrap.js";
import { loadAuthConfig } from "../../src/config.js";
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

const app = createAuthApp({ pool, config, logger, userCache: new UserListCache(redis, logger) });
const appWithRedisDown = createAuthApp({ pool, config, logger, userCache: new UserListCache(deadRedis, logger) });

beforeAll(async () => {
  await pool.query("DROP TABLE IF EXISTS clients, users, schema_migrations CASCADE");
  await runMigrations(pool, fileURLToPath(new URL("../../migrations", import.meta.url)), 4001, logger);
  await ensureAdmin(pool, "admin", "admin-password", logger);
  await redis.ping();
  await redis.del("cache:users");
});
afterAll(async () => {
  await Promise.all([pool.end(), redis.quit()]);
  deadRedis.disconnect();
});

describe("stage 2: Redis", () => {
  it("S2: GET /api/users is cached; creating a user clears the cache; Redis being down falls back to Postgres", async () => {
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin-password" });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    const first = await request(app).get("/api/users").set(auth);
    expect(first.body.map((u: { username: string }) => u.username)).toEqual(["admin"]);
    expect(JSON.parse((await redis.get("cache:users"))!)).toEqual(first.body);
    expect(await redis.ttl("cache:users")).toBeGreaterThan(0);

    await request(app)
      .post("/api/users")
      .set(auth)
      .send({ username: "kavya", password: "password123", displayName: "Kavya" })
      .expect(201);
    expect(await redis.get("cache:users")).toBeNull();
    const second = await request(app).get("/api/users").set(auth);
    expect(second.body.map((u: { username: string }) => u.username)).toEqual(["admin", "kavya"]);

    const fallback = await request(appWithRedisDown).get("/api/users").set(auth);
    expect(fallback.status).toBe(200);
    expect(fallback.body).toEqual(second.body);
  });
});
