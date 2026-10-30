import { baseConfigShape, loadConfig } from "@messenger/shared";
import { z } from "zod";

export const messageConfigShape = {
  ...baseConfigShape,
  PORT: z.coerce.number().int().default(4003),
  DATABASE_URL: z.string().min(1),
  INTERNAL_TOKEN: z.string().min(1),
  REDIS_URL: z.string().min(1),
};

export type MessageConfig = ReturnType<typeof loadMessageConfig>;

export const loadMessageConfig = (env?: NodeJS.ProcessEnv) => loadConfig(messageConfigShape, env);
