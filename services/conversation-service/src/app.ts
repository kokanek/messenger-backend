import { createApp, finishApp, type Logger } from "@messenger/shared";
import type { Db } from "mongodb";
import type { ConversationConfig } from "./config.js";
import type { MessageService } from "./message-service.js";
import { conversationRoutes } from "./routes/conversations.js";

export interface AppDeps {
  db: Db;
  config: ConversationConfig;
  logger: Logger;
  messageService: MessageService;
}

export function createConversationApp(deps: AppDeps) {
  const app = createApp({
    logger: deps.logger,
    allowedOrigins: deps.config.ALLOWED_ORIGINS,
    readiness: { mongo: () => deps.db.command({ ping: 1 }) },
  });
  app.use(conversationRoutes(deps));
  return finishApp(app);
}
