import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { runMigrations, signAccessToken, type ServerEvent } from "@messenger/shared";
import { pino } from "pino";
import pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { createMessageApp } from "../../src/app.js";
import type { Broadcaster } from "../../src/broadcaster.js";
import { loadMessageConfig } from "../../src/config.js";

export const DATABASE_URL =
  process.env.MESSAGE_TEST_DATABASE_URL ?? "postgres://message_svc:message-dev@localhost:5432/message_test";
export const INTERNAL_TOKEN = "test-internal-token";
export const logger = pino({ level: "silent" });
export const config = loadMessageConfig({
  JWT_SECRET: "test-secret-that-is-at-least-32-characters",
  ALLOWED_ORIGINS: "http://localhost:5180",
  DATABASE_URL,
  INTERNAL_TOKEN,
  REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1",
});

// Records what would have been pushed to sockets.
export class FakeBroadcaster implements Broadcaster {
  calls: { userIds: string[]; event: ServerEvent }[] = [];
  async publish(userIds: string[], event: ServerEvent) {
    this.calls.push({ userIds, event });
  }
}

export async function resetDatabase(pool: pg.Pool) {
  await pool.query(
    "DROP TABLE IF EXISTS messages, conversation_members, conversation_heads, schema_migrations CASCADE",
  );
  await runMigrations(pool, fileURLToPath(new URL("../../migrations", import.meta.url)), 4003, logger);
}

export function startApp(pool: pg.Pool, broadcaster: Broadcaster): Promise<Server> {
  const server = createServer(createMessageApp({ pool, config, logger, broadcaster }));
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

export interface TestUser {
  id: string;
  name: string;
  token: string;
}

export async function makeUser(name: string): Promise<TestUser> {
  const id = uuidv7();
  const token = await signAccessToken(
    config.JWT_SECRET,
    { userId: id, clientId: uuidv7(), role: "member", displayName: name },
    900,
  );
  return { id, name, token };
}
