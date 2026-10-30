import { existsSync } from "node:fs";
import type { ConversationSummary, LoginResponse, Message, ServerEvent } from "@messenger/shared";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

// Runs against the full stack through the gateway: `docker compose up`, then `npm run test:e2e`.
if (existsSync(".env")) process.loadEnvFile(".env");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin-dev-password";

async function api<T>(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

const login = async (username: string, password: string) => {
  const res = await api<LoginResponse>("POST", "/api/auth/login", undefined, { username, password });
  expect(res.status).toBe(200);
  return res.body;
};

const sockets: WebSocket[] = [];
afterAll(() => sockets.forEach((ws) => ws.close()));

// Opens a socket, authenticates, and resolves once `ready` arrives.
function device(token: string): Promise<{ next: (type: string) => Promise<ServerEvent> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws");
    sockets.push(ws);
    const events: ServerEvent[] = [];
    const waiters: { type: string; resolve: (e: ServerEvent) => void }[] = [];
    const next = (type: string) =>
      new Promise<ServerEvent>((res) => {
        const i = events.findIndex((e) => e.type === type);
        if (i >= 0) return res(events.splice(i, 1)[0]!);
        waiters.push({ type, resolve: res });
      });
    ws.on("message", (data) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      const i = waiters.findIndex((w) => w.type === event.type);
      if (i >= 0) waiters.splice(i, 1)[0]!.resolve(event);
      else events.push(event);
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", payload: { token } })));
    ws.on("error", reject);
    next("ready").then(() => resolve({ next }), reject);
  });
}

describe("end to end", () => {
  it("E1: users, a direct conversation, live delivery to two devices, and unread counts", async () => {
    const run = Date.now().toString(36);
    const admin = await login(ADMIN_USERNAME, ADMIN_PASSWORD);

    // The admin creates two users.
    for (const name of ["a", "b"]) {
      const created = await api("POST", "/api/users", admin.accessToken, {
        username: `e2e_${name}_${run}`,
        password: "password123",
        displayName: `E2E ${name.toUpperCase()}`,
      });
      expect(created.status).toBe(201);
    }

    // B logs in on two devices, and both connect.
    const bPhone = await login(`e2e_b_${run}`, "password123");
    const bLaptop = await login(`e2e_b_${run}`, "password123");
    const [phone, laptop] = await Promise.all([device(bPhone.accessToken), device(bLaptop.accessToken)]);

    // A creates a direct conversation with B and sends a message.
    const a = await login(`e2e_a_${run}`, "password123");
    const conversation = await api<ConversationSummary>("POST", "/api/conversations", a.accessToken, {
      type: "direct",
      memberIds: [bPhone.user.id],
    });
    expect(conversation.status).toBe(201);
    const sent = await api<Message>("POST", `/api/conversations/${conversation.body.id}/messages`, a.accessToken, {
      clientMessageId: crypto.randomUUID(),
      text: "Hello from A",
    });
    expect(sent.status).toBe(201);

    // Both of B's devices receive it.
    for (const d of [phone, laptop]) {
      expect((await d.next("message.created")).payload).toEqual(sent.body);
    }

    // B's list shows one unread; marking it read brings that to zero.
    const listFor = async () =>
      (await api<ConversationSummary[]>("GET", "/api/conversations", bPhone.accessToken)).body.find(
        (c) => c.id === conversation.body.id,
      )!;
    expect(await listFor()).toMatchObject({ unread: 1, lastMessage: { text: "Hello from A" } });
    const read = await api("POST", `/api/conversations/${conversation.body.id}/read`, bPhone.accessToken, {
      seq: sent.body.seq,
    });
    expect(read.status).toBe(200);
    expect((await listFor()).unread).toBe(0);
  });
});
