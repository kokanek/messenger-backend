import { AppError, signAccessToken, type ConversationSummary, type Summary } from "@messenger/shared";
import { MongoClient } from "mongodb";
import { pino } from "pino";
import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createConversationApp } from "../../src/app.js";
import { loadConversationConfig } from "../../src/config.js";
import type { MessageService, RegisterConversation } from "../../src/message-service.js";
import { conversations, ensureIndexes } from "../../src/store.js";

const MONGO_URL =
  process.env.CONVERSATION_TEST_MONGO_URL ??
  "mongodb://conversation_svc:conversation-dev@localhost:27017/messenger_test?authSource=messenger";

const config = loadConversationConfig({
  JWT_SECRET: "test-secret-that-is-at-least-32-characters",
  ALLOWED_ORIGINS: "http://localhost:5180",
  MONGO_URL,
  INTERNAL_TOKEN: "test-internal-token",
});

// Stands in for message-service: remembers registrations, can be told to fail, and
// answers summaries in whatever order the test sets.
class FakeMessageService implements MessageService {
  registered: RegisterConversation[] = [];
  failRegister = false;
  summaryOrder: string[] = [];
  unread: Record<string, number> = {};

  async registerConversation(input: RegisterConversation) {
    if (this.failRegister) throw new AppError("DEPENDENCY_UNAVAILABLE", "message-service is down");
    this.registered.push(input);
  }

  async summaries(_userId: string, conversationIds: string[]): Promise<Summary[]> {
    const ordered = this.summaryOrder.filter((id) => conversationIds.includes(id));
    const rest = conversationIds.filter((id) => !ordered.includes(id));
    return [...ordered, ...rest].map((id) => ({
      conversationId: id,
      lastSeq: this.unread[id] ?? 0,
      lastReadSeq: 0,
      unread: this.unread[id] ?? 0,
      lastMessageAt: new Date().toISOString(),
      lastMessage: null,
    }));
  }
}

const mongo = new MongoClient(MONGO_URL);
const db = mongo.db();
const messageService = new FakeMessageService();
const app = createConversationApp({ db, config, logger: pino({ level: "silent" }), messageService });

interface TestUser {
  id: string;
  token: string;
}
async function makeUser(name: string): Promise<TestUser> {
  const id = uuidv7();
  const token = await signAccessToken(
    config.JWT_SECRET,
    { userId: id, clientId: uuidv7(), role: "member", displayName: name },
    900,
  );
  return { id, token };
}

let priya: TestUser, arjun: TestUser, kavya: TestUser;

beforeAll(async () => {
  await mongo.connect();
  await conversations(db)
    .drop()
    .catch(() => {});
  await ensureIndexes(conversations(db));
  [priya, arjun, kavya] = await Promise.all(["Priya", "Arjun", "Kavya"].map(makeUser));
});
beforeEach(async () => {
  await conversations(db).deleteMany({});
  Object.assign(messageService, new FakeMessageService());
});
afterAll(() => mongo.close());

const create = (user: TestUser, body: object) =>
  request(app).post("/api/conversations").set("Authorization", `Bearer ${user.token}`).send(body);
const list = (user: TestUser) => request(app).get("/api/conversations").set("Authorization", `Bearer ${user.token}`);

describe("conversation-service", () => {
  it("C1: creating the same direct conversation twice, even concurrently, yields one; the repeat is 200", async () => {
    const [a, b] = await Promise.all([
      create(priya, { type: "direct", memberIds: [arjun.id] }),
      create(arjun, { type: "direct", memberIds: [priya.id] }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);

    const again = await create(priya, { type: "direct", memberIds: [arjun.id] });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(a.body.id);
    expect(await conversations(db).countDocuments()).toBe(1);
  });

  it("C2: the creator is always a member; bad direct and group bodies are 400", async () => {
    const group = await create(priya, {
      type: "group",
      name: "  Weekend trip ",
      memberIds: [arjun.id, kavya.id, arjun.id],
    });
    expect(group.status).toBe(201);
    expect(group.body).toMatchObject({
      type: "group",
      isGroup: true,
      name: "Weekend trip",
      unread: 0,
      lastMessage: null,
    });
    expect(group.body.memberIds).toEqual([priya.id, arjun.id, kavya.id]);
    expect(messageService.registered[0]!.memberIds).toEqual([priya.id, arjun.id, kavya.id]);

    const direct = await create(priya, { type: "direct", memberIds: [kavya.id] });
    expect(direct.body).toMatchObject({ type: "direct", isGroup: false, name: null });
    expect(direct.body.memberIds).toEqual([priya.id, kavya.id]);

    const tooMany = Array.from({ length: 256 }, () => uuidv7());
    for (const body of [
      { type: "direct", memberIds: [priya.id] }, // with yourself
      { type: "group", memberIds: [arjun.id] }, // no name
      { type: "group", name: "   ", memberIds: [arjun.id] }, // blank name
      { type: "group", name: "Too big", memberIds: tooMany },
      { type: "direct", memberIds: ["not-a-uuid"] },
    ]) {
      const res = await create(priya, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("C3: the list has only the caller's conversations, in message-service's order, with summaries merged", async () => {
    const first = (await create(priya, { type: "group", name: "First", memberIds: [arjun.id] })).body;
    const second = (await create(priya, { type: "direct", memberIds: [kavya.id] })).body;
    await create(arjun, { type: "direct", memberIds: [kavya.id] }); // priya isn't in this one

    messageService.summaryOrder = [second.id, first.id];
    messageService.unread = { [first.id]: 3 };
    const res = await list(priya);
    expect(res.status).toBe(200);
    const rows = res.body as ConversationSummary[];
    expect(rows.map((c) => c.id)).toEqual([second.id, first.id]);
    expect(rows[1]).toMatchObject({ name: "First", unread: 3, isGroup: true });
    expect((await list(kavya)).body).toHaveLength(2);
  });

  it("C4: if registering with message-service fails, the MongoDB document is removed and the API says 503", async () => {
    messageService.failRegister = true;
    const res = await create(priya, { type: "group", name: "Doomed", memberIds: [arjun.id] });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(await conversations(db).countDocuments()).toBe(0);
  });

  it("C5: re-creating an existing direct conversation registers it again, repairing a missing registration", async () => {
    const created = await create(priya, { type: "direct", memberIds: [arjun.id] });
    expect(messageService.registered).toHaveLength(1);
    const again = await create(priya, { type: "direct", memberIds: [arjun.id] });
    expect(again.status).toBe(200);
    expect(messageService.registered).toHaveLength(2);
    expect(messageService.registered[1]!.id).toBe(created.body.id);
  });
});
