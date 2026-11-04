import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createMessageApp } from "../../src/app.js";
import { LocalBroadcaster } from "../../src/broadcaster.js";
import { createMessageMetrics } from "../../src/metrics.js";
import { Registry } from "../../src/ws/registry.js";
import { attachWebSocketServer } from "../../src/ws/server.js";
import { DATABASE_URL, INTERNAL_TOKEN, config, logger, makeUser, resetDatabase } from "./helpers.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const metrics = createMessageMetrics();
let server: Server;
let wsUrl: string;

beforeAll(async () => {
  await resetDatabase(pool);
  const registry = new Registry();
  const broadcaster = new LocalBroadcaster(registry);
  server = createServer(createMessageApp({ pool, config, logger, broadcaster, metrics }));
  attachWebSocketServer({
    server,
    registry,
    broadcaster,
    jwtSecret: config.JWT_SECRET,
    allowedOrigins: config.ALLOWED_ORIGINS,
    logger,
    authTimeoutMs: 300,
    connections: metrics.websocketConnections,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await pool.end();
});

const valueOf = async (metric: { get(): Promise<{ values: { value: number }[] }> }) =>
  (await metric.get()).values[0]?.value ?? 0;

// Opens a socket, sends the auth frame and resolves on the first event (ready, or close).
function connect(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", payload: { token } })));
    ws.on("message", () => resolve(ws));
    ws.on("close", () => resolve(ws));
    ws.on("error", reject);
  });
}

const closed = (ws: WebSocket) => new Promise<void>((resolve) => ws.on("close", () => resolve()));

describe("message-service metrics", () => {
  it("M3: messenger_messages_sent_total counts a stored message once, even when the send is retried", async () => {
    const [priya, arjun] = await Promise.all([makeUser("Priya"), makeUser("Arjun")]);
    const id = uuidv7();
    await request(server)
      .post("/internal/conversations")
      .set("x-internal-token", INTERNAL_TOKEN)
      .send({ id, type: "direct", memberIds: [priya.id, arjun.id], createdAt: new Date().toISOString() })
      .expect(200);

    const before = await valueOf(metrics.messagesSent);
    const body = { clientMessageId: crypto.randomUUID(), text: "hello" };
    const send = () =>
      request(server)
        .post(`/api/conversations/${id}/messages`)
        .set("Authorization", `Bearer ${priya.token}`)
        .send(body);
    await send().expect(201);
    await send().expect(200); // the retry: same clientMessageId, nothing new stored
    expect((await valueOf(metrics.messagesSent)) - before).toBe(1);
  });

  it("M4: messenger_websocket_connections counts authenticated sockets only, and goes down on close", async () => {
    const priya = await makeUser("Priya");
    expect(await valueOf(metrics.websocketConnections)).toBe(0);

    const first = await connect(priya.token);
    const second = await connect(priya.token);
    const rejected = await connect("not-a-token"); // closed with 4401, never counted
    expect(await valueOf(metrics.websocketConnections)).toBe(2);

    const done = closed(first);
    first.close();
    await done;
    // The server's close handler runs right after the client sees the close.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await valueOf(metrics.websocketConnections)).toBe(1);

    second.close();
    rejected.terminate();
  });
});
