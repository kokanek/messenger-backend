import { connectWithRetry } from "@messenger/shared";
import { MongoClient } from "mongodb";
import pg from "pg";
import { pino } from "pino";

// Vitest global setup: wait until the test databases accept connections. Right after
// `docker compose up`, Postgres and MongoDB run their init scripts on a temporary server
// that the host can't reach yet, even though the containers already count as started.
export default async function waitForDatabases() {
  const logger = pino({ level: "warn" });
  for (const url of [
    process.env.AUTH_TEST_DATABASE_URL ?? "postgres://auth_svc:auth-dev@localhost:5432/auth_test",
    process.env.MESSAGE_TEST_DATABASE_URL ?? "postgres://message_svc:message-dev@localhost:5432/message_test",
  ]) {
    await connectWithRetry(
      "postgres",
      async () => {
        const client = new pg.Client({ connectionString: url });
        await client.connect();
        await client.end();
      },
      logger,
    );
  }
  const mongoUrl =
    process.env.CONVERSATION_TEST_MONGO_URL ??
    "mongodb://conversation_svc:conversation-dev@localhost:27017/messenger_test?authSource=messenger";
  await connectWithRetry(
    "mongo",
    async () => {
      const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 2000 });
      await client.connect();
      await client.db().command({ ping: 1 });
      await client.close();
    },
    logger,
  );
}
