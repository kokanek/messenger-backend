import { AppError, signAccessToken, type Summary } from "@messenger/shared";
import { MongoClient } from "mongodb";
import { pino } from "pino";
import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConversationApp } from "../../src/app.js";
import { loadConversationConfig } from "../../src/config.js";
import type { MessageService } from "../../src/message-service.js";
import { createConversationMetrics } from "../../src/metrics.js";
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

// A message-service that is always down.
const downMessageService: MessageService = {
  async registerConversation() {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "message-service is down");
  },
  async summaries(): Promise<Summary[]> {
    return [];
  },
};

const mongo = new MongoClient(MONGO_URL);
const db = mongo.db();
const metrics = createConversationMetrics();
const app = createConversationApp({
  db,
  config,
  logger: pino({ level: "silent" }),
  messageService: downMessageService,
  metrics,
});

beforeAll(async () => {
  await mongo.connect();
  await conversations(db).deleteMany({});
  await ensureIndexes(conversations(db));
});
afterAll(() => mongo.close());

describe("conversation-service metrics", () => {
  it("M5: messenger_conversation_compensations_total counts each create that had to be undone", async () => {
    const token = await signAccessToken(
      config.JWT_SECRET,
      { userId: uuidv7(), clientId: uuidv7(), role: "member", displayName: "Priya" },
      900,
    );
    await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "group", name: "Doomed", memberIds: [uuidv7()] })
      .expect(503);

    expect((await metrics.compensations.get()).values[0]?.value).toBe(1);
    expect(await conversations(db).countDocuments()).toBe(0);
  });
});
