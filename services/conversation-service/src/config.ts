import { baseConfigShape, loadConfig } from "@messenger/shared";
import { z } from "zod";

export const conversationConfigShape = {
  ...baseConfigShape,
  PORT: z.coerce.number().int().default(4002),
  MONGO_URL: z.string().min(1),
  MESSAGE_SERVICE_URL: z.url().default("http://message-service:4003"),
  INTERNAL_TOKEN: z.string().min(1),
};

export type ConversationConfig = ReturnType<typeof loadConversationConfig>;

export const loadConversationConfig = (env?: NodeJS.ProcessEnv) => loadConfig(conversationConfigShape, env);
