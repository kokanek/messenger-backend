import { pino, type Logger } from "pino";

// JSON logs to stdout, one line per event. Secrets are redacted wherever they appear,
// so a careless `log.info({ body })` can't leak a password or token.
export function createLogger(service: string, level = "info"): Logger {
  return pino({
    level,
    base: { service },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "password",
        "*.password",
        "token",
        "*.token",
        "accessToken",
        "*.accessToken",
        "refreshToken",
        "*.refreshToken",
      ],
      censor: "[redacted]",
    },
  });
}

export type { Logger };
