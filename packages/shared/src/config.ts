import { z } from "zod";

// Settings every service reads (backend spec, section 11.1).
export const baseConfigShape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
};

// Parses process.env against a zod shape. A service calls this first thing at startup,
// so a missing or malformed variable stops it with a clear message instead of failing later.
export function loadConfig<Shape extends z.ZodRawShape>(
  shape: Shape,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<z.ZodObject<Shape>> {
  const result = z.object(shape).safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
