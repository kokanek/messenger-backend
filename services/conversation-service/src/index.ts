import { connectWithRetry, createInternalClient, createLogger, handleShutdown } from "@messenger/shared";
import { MongoClient } from "mongodb";
import { createConversationApp } from "./app.js";
import { loadConversationConfig } from "./config.js";
import { httpMessageService } from "./message-service.js";
import { createConversationMetrics } from "./metrics.js";
import { conversations, ensureIndexes } from "./store.js";

const config = loadConversationConfig();
const logger = createLogger("conversation-service", config.LOG_LEVEL);
const metrics = createConversationMetrics();
const mongo = new MongoClient(config.MONGO_URL, { serverSelectionTimeoutMS: 3000 });

// The mongo container has no healthcheck (it would cost too much memory on a 1 GB VM),
// so compose can't wait for it: retry here instead (backend spec, section 12.2).
await connectWithRetry("mongo", () => mongo.connect(), logger);
const db = mongo.db(); // the database named in MONGO_URL
await ensureIndexes(conversations(db));

const messageService = httpMessageService(
  createInternalClient(config.MESSAGE_SERVICE_URL, config.INTERNAL_TOKEN, logger),
);
const server = createConversationApp({ db, config, logger, messageService, metrics }).listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "conversation-service listening");
});

handleShutdown({ server, logger, close: () => mongo.close() });
