import { fileURLToPath } from "node:url";
import { runMigrations } from "@messenger/shared";
import { pino } from "pino";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthApp } from "../../src/app.js";
import { ensureAdmin } from "../../src/bootstrap.js";
import { loadAuthConfig } from "../../src/config.js";
import { insertUser } from "../../src/users.js";

const DATABASE_URL = process.env.AUTH_TEST_DATABASE_URL ?? "postgres://auth_svc:auth-dev@localhost:5432/auth_test";
const logger = pino({ level: "silent" });
const config = loadAuthConfig({
  JWT_SECRET: "test-secret-that-is-at-least-32-characters",
  ALLOWED_ORIGINS: "http://localhost:5180",
  DATABASE_URL,
  REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1",
});
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const app = createAuthApp({ pool, config, logger });

beforeAll(async () => {
  await pool.query("DROP TABLE IF EXISTS clients, users, schema_migrations CASCADE");
  await runMigrations(pool, fileURLToPath(new URL("../../migrations", import.meta.url)), 4001, logger);
});
beforeEach(async () => {
  await pool.query("TRUNCATE clients, users CASCADE");
});
afterAll(() => pool.end());

const refresh = (refreshToken: string) => request(app).post("/api/auth/refresh").send({ refreshToken });
const withoutRequestId = (body: { error: object }) => ({ ...body.error, requestId: undefined });

async function login(username: string, password = "password123") {
  return request(app).post("/api/auth/login").send({ username, password });
}

describe("auth-service", () => {
  it("A1: admin bootstrap creates the admin once and never changes it", async () => {
    await ensureAdmin(pool, "admin", "first-password", logger);
    await ensureAdmin(pool, "admin", "second-password", logger);
    const { rows } = await pool.query("SELECT username FROM users WHERE role = 'admin'");
    expect(rows).toEqual([{ username: "admin" }]);
    expect((await login("admin", "first-password")).status).toBe(200);
    expect((await login("admin", "second-password")).status).toBe(401);
  });

  it("A2: login returns an access token, a refresh token and the user, and sets no cookie", async () => {
    await insertUser(pool, {
      username: "priya",
      password: "password123",
      displayName: "Priya",
      role: "member",
      createdBy: null,
    });
    const res = await login("Priya"); // usernames are case-insensitive
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      expiresIn: 900,
      user: { username: "priya", displayName: "Priya", role: "member" },
    });
    expect(typeof res.body.accessToken).toBe("string");
    // `<clientId>.<secret>`: the app keeps it in localStorage and sends it back itself.
    expect(res.body.refreshToken).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("A3: wrong password and unknown user get identical 401 INVALID_CREDENTIALS bodies", async () => {
    await insertUser(pool, {
      username: "priya",
      password: "password123",
      displayName: "Priya",
      role: "member",
      createdBy: null,
    });
    const wrongPassword = await login("priya", "wrong-password");
    const unknownUser = await login("nobody", "wrong-password");
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(withoutRequestId(wrongPassword.body)).toEqual(withoutRequestId(unknownUser.body));
  });

  it("A4: refresh rotates the refresh token; reusing the old one revokes the device", async () => {
    await insertUser(pool, {
      username: "priya",
      password: "password123",
      displayName: "Priya",
      role: "member",
      createdBy: null,
    });
    const first: string = (await login("priya")).body.refreshToken;

    const refreshed = await refresh(first);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.user.username).toBe("priya");
    expect(typeof refreshed.body.accessToken).toBe("string");
    const second: string = refreshed.body.refreshToken;
    expect(second).not.toBe(first);

    const reused = await refresh(first);
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe("REFRESH_INVALID");
    // The device is now revoked, so even the newest refresh token stops working.
    expect((await refresh(second)).status).toBe(401);
    expect((await refresh("not-a-token")).status).toBe(401);
  });

  it("A5: after logout the refresh token fails; another device still refreshes", async () => {
    await insertUser(pool, {
      username: "priya",
      password: "password123",
      displayName: "Priya",
      role: "member",
      createdBy: null,
    });
    const phone = await login("priya");
    const laptop = await login("priya");

    const logout = await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${phone.body.accessToken}`);
    expect(logout.status).toBe(204);

    const phoneRefresh = await refresh(phone.body.refreshToken);
    expect(phoneRefresh.status).toBe(401);
    expect(phoneRefresh.body.error.code).toBe("REFRESH_INVALID");
    const laptopRefresh = await refresh(laptop.body.refreshToken);
    expect(laptopRefresh.status).toBe(200);
  });

  it("A6: a member calling POST /api/users gets 403 FORBIDDEN", async () => {
    await insertUser(pool, {
      username: "priya",
      password: "password123",
      displayName: "Priya",
      role: "member",
      createdBy: null,
    });
    const { body } = await login("priya");
    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ username: "arjun", password: "password123", displayName: "Arjun" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("A7: duplicate username is 409 USERNAME_TAKEN; an invalid username is 400", async () => {
    await ensureAdmin(pool, "admin", "admin-password", logger);
    const { body } = await login("admin", "admin-password");
    const create = (username: string) =>
      request(app)
        .post("/api/users")
        .set("Authorization", `Bearer ${body.accessToken}`)
        .send({ username, password: "password123", displayName: "Arjun" });

    const created = await create("Arjun");
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ username: "arjun", displayName: "Arjun", role: "member" });
    expect((await create("arjun")).body.error.code).toBe("USERNAME_TAKEN");
    const invalid = await create("Arjun!");
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("A8: GET /api/users returns every user sorted by display name, without password hashes", async () => {
    for (const [username, displayName] of [
      ["neha", "Neha"],
      ["arjun", "Arjun"],
      ["kavya", "Kavya"],
    ]) {
      await insertUser(pool, {
        username: username!,
        password: "password123",
        displayName: displayName!,
        role: "member",
        createdBy: null,
      });
    }
    const { body } = await login("kavya");
    const res = await request(app).get("/api/users").set("Authorization", `Bearer ${body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.map((u: { displayName: string }) => u.displayName)).toEqual(["Arjun", "Kavya", "Neha"]);
    expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/);
    expect((await request(app).get("/api/users")).status).toBe(401);
  });
});
