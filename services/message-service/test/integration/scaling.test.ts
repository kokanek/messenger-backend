import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRedis, type Redis, type ServerEvent } from "@messenger/shared";
import pg from "pg";
import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createMessageApp } from "../../src/app.js";
import { RedisBroadcaster } from "../../src/broadcaster.js";
import { Registry } from "../../src/ws/registry.js";
import { attachWebSocketServer } from "../../src/ws/server.js";
import { DATABASE_URL, INTERNAL_TOKEN, config, logger, makeUser, resetDatabase } from "./helpers.js";

// Stage 2: two message-service "processes" (two servers in one test process, each with its
// own registry and Redis connections) sharing one database and one Redis.
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const connections: Redis[] = [];
const servers: Server[] = [];
const sockets: WebSocket[] = [];

async function startInstance() {
  const publisher = createRedis(config.REDIS_URL, logger);
  const subscriber = createRedis(config.REDIS_URL, logger);
  connections.push(publisher, subscriber);
  const registry = new Registry();
  const broadcaster = new RedisBroadcaster(publisher, subscriber, registry);
  const server = createServer(createMessageApp({ pool, config, logger, broadcaster, redis: publisher }));
  attachWebSocketServer({
    server,
    registry,
    broadcaster,
    jwtSecret: config.JWT_SECRET,
    allowedOrigins: config.ALLOWED_ORIGINS,
    logger,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  servers.push(server);
  return { server, wsUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws` };
}

// Connects, authenticates, and waits for `ready`; then collects message.created events.
function connect(wsUrl: string, token: string) {
  return new Promise<{ nextMessage: () => Promise<ServerEvent> }>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    sockets.push(ws);
    const queue: ServerEvent[] = [];
    let waiting: ((e: ServerEvent) => void) | undefined;
    ws.on("message", (data) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      if (event.type === "ready") {
        return resolve({
          nextMessage: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((res) => (waiting = res))),
        });
      }
      if (waiting) {
        waiting(event);
        waiting = undefined;
      } else queue.push(event);
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", payload: { token } })));
    ws.on("error", reject);
  });
}

beforeAll(() => resetDatabase(pool));
afterAll(async () => {
  sockets.forEach((ws) => ws.close());
  servers.forEach((s) => {
    s.closeAllConnections();
    s.close();
  });
  await Promise.all(connections.map((c) => c.quit()));
  await pool.end();
});

describe("stage 2: Redis", () => {
  it("S1: a sender on one process reaches recipients connected to another, on every device", async () => {
    const a = await startInstance();
    const b = await startInstance();
    const [priya, arjun] = await Promise.all([makeUser("Priya"), makeUser("Arjun")]);

    const conversation = uuidv7();
    await request(a.server)
      .post("/internal/conversations")
      .set("x-internal-token", INTERNAL_TOKEN)
      .send({ id: conversation, type: "direct", memberIds: [priya.id, arjun.id], createdAt: new Date().toISOString() })
      .expect(200);

    const arjunOnA = await connect(a.wsUrl, arjun.token);
    const arjunOnB = await connect(b.wsUrl, arjun.token);
    const priyaOnB = await connect(b.wsUrl, priya.token); // the author's other device

    // Priya sends through process A. With LocalBroadcaster, only arjunOnA would hear it.
    const sent = await request(a.server)
      .post(`/api/conversations/${conversation}/messages`)
      .set("Authorization", `Bearer ${priya.token}`)
      .send({ clientMessageId: crypto.randomUUID(), text: "Across processes" })
      .expect(201);

    for (const device of [arjunOnA, arjunOnB, priyaOnB]) {
      expect(await device.nextMessage()).toEqual({ type: "message.created", payload: sent.body });
    }
  });
});
