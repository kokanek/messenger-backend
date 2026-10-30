import type { Server } from "node:http";
import type { Message, Summary } from "@messenger/shared";
import pg from "pg";
import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DATABASE_URL,
  FakeBroadcaster,
  INTERNAL_TOKEN,
  makeUser,
  resetDatabase,
  startApp,
  type TestUser,
} from "./helpers.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
const broadcaster = new FakeBroadcaster();
let server: Server;
let priya: TestUser, arjun: TestUser, kavya: TestUser, outsider: TestUser;

beforeAll(async () => {
  await resetDatabase(pool);
  server = await startApp(pool, broadcaster);
  [priya, arjun, kavya, outsider] = await Promise.all(
    ["Priya", "Arjun", "Kavya", "Outsider"].map((name) => makeUser(name)),
  );
});
beforeEach(async () => {
  await pool.query("TRUNCATE messages, conversation_members, conversation_heads");
  broadcaster.calls = [];
});
afterAll(async () => {
  server.close();
  await pool.end();
});

// Plays conversation-service's part: register a conversation and its members.
async function register(memberIds: string[], createdAt = new Date().toISOString()) {
  const id = uuidv7();
  const res = await request(server)
    .post("/internal/conversations")
    .set("x-internal-token", INTERNAL_TOKEN)
    .send({ id, type: memberIds.length === 2 ? "direct" : "group", memberIds, createdAt });
  expect(res.status).toBe(200);
  return id;
}

function send(user: TestUser, conversationId: string, text: string, clientMessageId: string = crypto.randomUUID()) {
  return request(server)
    .post(`/api/conversations/${conversationId}/messages`)
    .set("Authorization", `Bearer ${user.token}`)
    .send({ clientMessageId, text });
}

const history = (user: TestUser, conversationId: string, query = "") =>
  request(server)
    .get(`/api/conversations/${conversationId}/messages${query}`)
    .set("Authorization", `Bearer ${user.token}`);

const markRead = (user: TestUser, conversationId: string, seq: number) =>
  request(server)
    .post(`/api/conversations/${conversationId}/read`)
    .set("Authorization", `Bearer ${user.token}`)
    .send({ seq });

async function summaries(user: TestUser, conversationIds: string[]): Promise<Summary[]> {
  const res = await request(server)
    .post("/internal/summaries")
    .set("x-internal-token", INTERNAL_TOKEN)
    .send({ userId: user.id, conversationIds });
  expect(res.status).toBe(200);
  return res.body.items;
}

describe("message-service", () => {
  it("MS1: 200 concurrent sends get contiguous seq values, none missing or repeated", async () => {
    const conversation = await register([priya.id, arjun.id, kavya.id]);
    const senders = [priya, arjun, kavya];
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => send(senders[i % 3]!, conversation, `message ${i}`)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const seqs = results.map((r) => r.body.seq as number).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  });

  it("MS2: a repeated clientMessageId returns the original with 200 and wastes no seq; reuse elsewhere is 409", async () => {
    const conversation = await register([priya.id, arjun.id]);
    const clientMessageId = crypto.randomUUID();
    const first = await send(priya, conversation, "hello", clientMessageId);
    const again = await send(priya, conversation, "hello", clientMessageId);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect((await send(arjun, conversation, "next")).body.seq).toBe(2);

    const other = await register([priya.id, kavya.id]);
    const reused = await send(priya, other, "hello", clientMessageId);
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("CLIENT_MESSAGE_ID_REUSED");
  });

  it("MS3: a non-member gets 403 on history, send and read; an unknown conversation is 404", async () => {
    const conversation = await register([priya.id, arjun.id]);
    for (const res of [
      await history(outsider, conversation),
      await send(outsider, conversation, "hi"),
      await markRead(outsider, conversation, 1),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("NOT_A_MEMBER");
    }
    const unknown = await history(priya, uuidv7());
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");
  });

  it("MS4: paging with cursor returns every message once, each page oldest first, ending with null", async () => {
    const conversation = await register([priya.id, arjun.id]);
    for (let i = 1; i <= 65; i++) await send(i % 2 ? priya : arjun, conversation, `message ${i}`);

    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await history(priya, conversation, cursor ? `?cursor=${cursor}` : "");
      expect(res.status).toBe(200);
      const seqs = (res.body.messages as Message[]).map((m) => m.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // oldest first
      seen.unshift(...seqs);
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 65 }, (_, i) => i + 1));

    expect((await history(priya, conversation, "?cursor=abc")).body.error.code).toBe("INVALID_CURSOR");
  });

  it("MS5: the read position ignores lower values and clamps values beyond lastSeq", async () => {
    const conversation = await register([priya.id, arjun.id]);
    for (let i = 0; i < 5; i++) await send(arjun, conversation, `message ${i}`);
    expect((await markRead(priya, conversation, 3)).body).toEqual({ conversationId: conversation, lastReadSeq: 3 });
    expect((await markRead(priya, conversation, 1)).body.lastReadSeq).toBe(3);
    expect((await markRead(priya, conversation, 9999)).body.lastReadSeq).toBe(5);
  });

  it("MS6: your own messages don't add to your unread count; other people's do", async () => {
    const conversation = await register([priya.id, arjun.id]);
    await send(priya, conversation, "one");
    await send(priya, conversation, "two");
    expect((await summaries(priya, [conversation]))[0]!.unread).toBe(0);
    expect((await summaries(arjun, [conversation]))[0]!.unread).toBe(2);
    // Replying moves your read position to your own message: you've seen what came before.
    await send(arjun, conversation, "three");
    expect((await summaries(priya, [conversation]))[0]!.unread).toBe(1);
    expect((await summaries(arjun, [conversation]))[0]!.unread).toBe(0);
  });

  it("MS7: registering the same conversation twice stores members once and reports created: false", async () => {
    const id = uuidv7();
    const body = { id, type: "group", memberIds: [priya.id, arjun.id, kavya.id], createdAt: new Date().toISOString() };
    const post = () =>
      request(server).post("/internal/conversations").set("x-internal-token", INTERNAL_TOKEN).send(body);
    expect((await post()).body).toEqual({ created: true });
    expect((await post()).body).toEqual({ created: false });
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1",
      [id],
    );
    expect(rows[0].n).toBe(3);
  });

  it("MS8: summaries are newest activity first with the last message; empty conversations sort by creation time", async () => {
    const older = await register([priya.id, arjun.id], "2026-01-01T10:00:00.000Z");
    const empty = await register([priya.id, kavya.id], "2026-01-02T10:00:00.000Z");
    const newer = await register([priya.id, arjun.id, kavya.id], "2026-01-01T09:00:00.000Z");
    const notMine = await register([arjun.id, kavya.id]);
    await send(arjun, older, "older message");
    await send(kavya, newer, "newest message");

    const items = await summaries(priya, [older, empty, newer, notMine]);
    expect(items.map((s) => s.conversationId)).toEqual([newer, older, empty]);
    expect(items[0]!.lastMessage).toMatchObject({ text: "newest message", seq: 1, authorName: "Kavya" });
    expect(items[2]).toMatchObject({
      lastMessage: null,
      lastSeq: 0,
      unread: 0,
      lastMessageAt: "2026-01-02T10:00:00.000Z",
    });
  });

  it("MS9: a send publishes message.created once, to every member including the author", async () => {
    const conversation = await register([priya.id, arjun.id, kavya.id]);
    const res = await send(priya, conversation, "hi all");
    expect(broadcaster.calls).toHaveLength(1);
    expect(broadcaster.calls[0]!.userIds.sort()).toEqual([priya.id, arjun.id, kavya.id].sort());
    expect(broadcaster.calls[0]!.event).toEqual({ type: "message.created", payload: res.body });

    await send(priya, conversation, "hi all", res.body.clientMessageId); // a retry stores and pushes nothing
    expect(broadcaster.calls).toHaveLength(1);
  });

  it("MS10: empty, whitespace-only and 4001-character text each return 400", async () => {
    const conversation = await register([priya.id, arjun.id]);
    for (const text of ["", "   \n ", "x".repeat(4001)]) {
      const res = await send(priya, conversation, text);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    }
    expect((await send(priya, conversation, "x".repeat(4000))).status).toBe(201);
  });

  it("MS11: internal endpoints return 401 without the right X-Internal-Token", async () => {
    for (const path of ["/internal/conversations", "/internal/summaries"]) {
      expect((await request(server).post(path).send({})).status).toBe(401);
      expect((await request(server).post(path).set("x-internal-token", "wrong").send({})).status).toBe(401);
    }
  });
});
