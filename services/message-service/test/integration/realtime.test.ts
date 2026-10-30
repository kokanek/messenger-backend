import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerEvent } from "@messenger/shared";
import pg from "pg";
import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createMessageApp } from "../../src/app.js";
import { LocalBroadcaster } from "../../src/broadcaster.js";
import { Registry } from "../../src/ws/registry.js";
import { attachWebSocketServer } from "../../src/ws/server.js";
import { DATABASE_URL, INTERNAL_TOKEN, config, logger, makeUser, resetDatabase, type TestUser } from "./helpers.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
let server: Server;
let wsUrl: string;

beforeAll(async () => {
  await resetDatabase(pool);
  const registry = new Registry();
  const broadcaster = new LocalBroadcaster(registry);
  server = createServer(createMessageApp({ pool, config, logger, broadcaster }));
  attachWebSocketServer({
    server,
    registry,
    broadcaster,
    jwtSecret: config.JWT_SECRET,
    allowedOrigins: config.ALLOWED_ORIGINS,
    logger,
    authTimeoutMs: 300,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await pool.end();
});

// A connected socket that collects every event it receives.
interface Device {
  ws: WebSocket;
  events: ServerEvent[];
  next(type: string): Promise<ServerEvent>;
}

function connect(token?: string, origin?: string): Promise<Device> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, origin ? { headers: { origin } } : {});
    const events: ServerEvent[] = [];
    const waiters: { type: string; resolve: (e: ServerEvent) => void }[] = [];
    ws.on("message", (data) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      events.push(event);
      const i = waiters.findIndex((w) => w.type === event.type);
      if (i >= 0) waiters.splice(i, 1)[0]!.resolve(event);
    });
    const device: Device = {
      ws,
      events,
      next: (type) => {
        const seen = events.find((e) => e.type === type);
        if (seen) {
          events.splice(events.indexOf(seen), 1);
          return Promise.resolve(seen);
        }
        return new Promise((res) => waiters.push({ type, resolve: res }));
      },
    };
    ws.on("open", () => {
      if (token) ws.send(JSON.stringify({ type: "auth", payload: { token } }));
      resolve(device);
    });
    ws.on("error", reject);
  });
}

const closeCode = (ws: WebSocket) => new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));

async function register(memberIds: string[]) {
  const id = uuidv7();
  await request(server)
    .post("/internal/conversations")
    .set("x-internal-token", INTERNAL_TOKEN)
    .send({ id, type: "group", memberIds, createdAt: new Date().toISOString() })
    .expect(200);
  return id;
}

const send = (user: TestUser, conversationId: string, text: string) =>
  request(server)
    .post(`/api/conversations/${conversationId}/messages`)
    .set("Authorization", `Bearer ${user.token}`)
    .send({ clientMessageId: crypto.randomUUID(), text });

describe("realtime", () => {
  it("R1: no auth frame within the timeout closes with 4401; so does a bad token", async () => {
    const silent = await connect();
    expect(await closeCode(silent.ws)).toBe(4401);

    const bad = await connect("not-a-jwt");
    expect(await closeCode(bad.ws)).toBe(4401);
  });

  it("R1: a disallowed Origin is refused before the upgrade", async () => {
    await expect(connect(undefined, "https://evil.example")).rejects.toThrow(/403/);
  });

  it("R2: every device of every member gets message.created, including the author's other device", async () => {
    const [priya, arjun] = await Promise.all([makeUser("Priya"), makeUser("Arjun")]);
    const conversation = await register([priya.id, arjun.id]);

    const priyaPhone = await connect(priya.token);
    const priyaLaptop = await connect(priya.token);
    const arjunPhone = await connect(arjun.token);
    const arjunLaptop = await connect(arjun.token);
    for (const device of [priyaPhone, priyaLaptop, arjunPhone, arjunLaptop]) {
      expect((await device.next("ready")).payload).toMatchObject({ userId: expect.any(String) });
    }

    const sent = await send(priya, conversation, "Hi Arjun");
    expect(sent.status).toBe(201);
    for (const device of [priyaPhone, priyaLaptop, arjunPhone, arjunLaptop]) {
      expect(await device.next("message.created")).toEqual({ type: "message.created", payload: sent.body });
    }

    // Anything but auth after authenticating gets an error frame, not a disconnect.
    arjunPhone.ws.send(JSON.stringify({ type: "message.send", payload: {} }));
    expect((await arjunPhone.next("error")).payload).toMatchObject({ code: "UNSUPPORTED_FRAME" });

    for (const device of [priyaPhone, priyaLaptop, arjunPhone, arjunLaptop]) device.ws.close();
  });
});
