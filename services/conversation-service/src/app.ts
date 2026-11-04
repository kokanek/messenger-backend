import { createApp, finishApp, type Logger } from "@messenger/shared";
import type { Db } from "mongodb";
import type { ConversationConfig } from "./config.js";
import type { MessageService } from "./message-service.js";
import type { ConversationMetrics } from "./metrics.js";
import { conversationRoutes } from "./routes/conversations.js";

export interface AppDeps {
  db: Db;
  config: ConversationConfig;
  logger: Logger;
  messageService: MessageService;
  // Module 5. Without it (as in most tests), no /metrics route and nothing is counted.
  metrics?: ConversationMetrics;
}

export function createConversationApp(deps: AppDeps) {
  const app = createApp({
    logger: deps.logger,
    allowedOrigins: deps.config.ALLOWED_ORIGINS,
    readiness: { mongo: () => deps.db.command({ ping: 1 }) },
    metrics: deps.metrics,
  });
  app.use(conversationRoutes(deps));
  return finishApp(app);
}
