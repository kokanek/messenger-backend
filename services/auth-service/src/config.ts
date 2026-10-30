import { baseConfigShape, loadConfig } from "@messenger/shared";
import { z } from "zod";

export const authConfigShape = {
  ...baseConfigShape,
  PORT: z.coerce.number().int().default(4001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // The first admin, created on startup if no admin exists yet (section 10.1).
  ADMIN_USERNAME: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
};

export type AuthConfig = ReturnType<typeof loadAuthConfig>;

export const loadAuthConfig = (env?: NodeJS.ProcessEnv) => loadConfig(authConfigShape, env);
