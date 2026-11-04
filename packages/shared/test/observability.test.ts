import { Writable } from "node:stream";
import { pino } from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, createMetrics, finishApp } from "../src/index.js";

// A logger that keeps every JSON line it writes, so a test can read them back.
function capturingLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n")) if (line) lines.push(line);
      done();
    },
  });
  return { logger: pino({ level: "info" }, stream), lines };
}

describe("request logging", () => {
  it("puts the request id on the request line exactly once, equal to X-Request-Id", async () => {
    const { logger, lines } = capturingLogger();
    const app = createApp({ logger, allowedOrigins: [], readiness: {} });
    app.get("/x", (_req, res) => void res.json({ ok: true }));
    finishApp(app);

    const res = await request(app).get("/x").set("X-Request-Id", "req-123");
    expect(res.headers["x-request-id"]).toBe("req-123");

    // Checked on the raw text: a key written twice is visible there, but JSON.parse hides it.
    const raw = lines.find((line) => line.includes('"request completed"'));
    expect(raw).toBeDefined();
    expect(raw!.match(/"requestId"/g)).toHaveLength(1);
    expect(JSON.parse(raw!).requestId).toBe("req-123");
  });
});

describe("metrics", () => {
  function appWithMetrics() {
    const metrics = createMetrics("test-service");
    const app = createApp({ logger: pino({ level: "silent" }), allowedOrigins: [], readiness: {}, metrics });
    app.get("/x/:id", (_req, res) => void res.json({ ok: true }));
    return finishApp(app);
  }

  it("serves Prometheus text with the route template, not the raw URL", async () => {
    const app = appWithMetrics();
    await request(app).get("/x/123").expect(200);

    const res = await request(app).get("/metrics").expect(200);
    expect(res.headers["content-type"]).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(res.text).toMatch(
      /http_request_duration_seconds_count\{[^}]*route="\/x\/:id"[^}]*status_code="200"[^}]*\} 1/,
    );
    expect(res.text).toContain('service="test-service"');
    expect(res.text).not.toContain("/x/123");
  });

  it("does not count /health, /ready or /metrics", async () => {
    const app = appWithMetrics();
    await request(app).get("/health");
    await request(app).get("/ready");
    await request(app).get("/metrics");
    const res = await request(app).get("/metrics");
    expect(res.text).not.toMatch(/http_request_duration_seconds_count\{/);
  });

  it('counts an unknown path as route="unmatched"', async () => {
    const app = appWithMetrics();
    await request(app).get("/no/such/path/42").expect(404);
    const res = await request(app).get("/metrics");
    expect(res.text).toMatch(/http_request_duration_seconds_count\{[^}]*route="unmatched"[^}]*status_code="404"/);
    expect(res.text).not.toContain("/no/such/path");
  });

  it("has no /metrics route when the app is built without metrics", async () => {
    const app = finishApp(createApp({ logger: pino({ level: "silent" }), allowedOrigins: [], readiness: {} }));
    await request(app).get("/metrics").expect(404);
  });
});
