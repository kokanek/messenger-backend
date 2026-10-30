import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { pino } from "pino";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AppError,
  createInternalClient,
  errorHandler,
  requireInternal,
  signAccessToken,
  verifyAccessToken,
} from "../src/index.js";

const SECRET = "test-secret-that-is-at-least-32-characters";
const silent = pino({ level: "silent" });

describe("access tokens", () => {
  const auth = { userId: "u1", clientId: "c1", role: "member" as const, displayName: "Priya" };

  it("round-trips the claims", async () => {
    const token = await signAccessToken(SECRET, auth, 60);
    expect(await verifyAccessToken(SECRET, token)).toEqual(auth);
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signAccessToken("another-secret-that-is-at-least-32-chars", auth, 60);
    await expect(verifyAccessToken(SECRET, token)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects an expired token", async () => {
    const token = await signAccessToken(SECRET, auth, -1);
    await expect(verifyAccessToken(SECRET, token)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("error handler", () => {
  const app = express();
  app.get("/app-error", () => {
    throw new AppError("NOT_A_MEMBER", "You are not a member of this conversation");
  });
  app.get("/zod-error", () => {
    z.object({ seq: z.number() }).parse({ seq: "x" });
  });
  app.get("/crash", () => {
    throw new Error("secret internals");
  });
  app.use(errorHandler);

  it("returns the standard error body", async () => {
    const res = await request(app).get("/app-error");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: "NOT_A_MEMBER",
        message: "You are not a member of this conversation",
        requestId: null,
        details: null,
      },
    });
  });

  it("turns zod errors into 400 VALIDATION_FAILED with the issues", async () => {
    const res = await request(app).get("/zod-error");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(res.body.error.details[0].path).toEqual(["seq"]);
  });

  it("never leaks an unexpected error's message", async () => {
    const res = await request(app).get("/crash");
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret internals");
  });
});

describe("internal calls", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it("retries 503 and then succeeds, forwarding the token and request id", async () => {
    let calls = 0;
    const url = await serve((req, res) => {
      calls++;
      expect(req.headers["x-internal-token"]).toBe("internal");
      expect(req.headers["x-request-id"]).toBe("req-1");
      res.statusCode = calls < 3 ? 503 : 200;
      res.end(JSON.stringify({ ok: true }));
    });
    const client = createInternalClient(url, "internal", silent);
    expect(await client.post("/x", {}, "req-1")).toEqual({ status: 200, body: { ok: true } });
    expect(calls).toBe(3);
  });

  it("gives up after two retries with DEPENDENCY_UNAVAILABLE", async () => {
    let calls = 0;
    const url = await serve((_req, res) => {
      calls++;
      res.statusCode = 503;
      res.end("{}");
    });
    const client = createInternalClient(url, "internal", silent);
    await expect(client.post("/x", {})).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 503 });
    expect(calls).toBe(3);
  });

  it("requireInternal rejects a missing or wrong token", async () => {
    const app = express();
    app.post("/internal/x", requireInternal("right-token"), (_req, res) => {
      res.json({ ok: true });
    });
    expect((await request(app).post("/internal/x")).status).toBe(401);
    expect((await request(app).post("/internal/x").set("x-internal-token", "wrong")).status).toBe(401);
    expect((await request(app).post("/internal/x").set("x-internal-token", "right-token")).status).toBe(200);
  });
});
