import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import { AppError } from "./errors.js";

// Internal endpoints (/internal/*) are never routed by the gateway, and on top of that
// every call must carry the shared secret (backend spec, section 9).
export function requireInternal(internalToken: string): RequestHandler {
  const expected = digest(internalToken);
  return (req, res, next) => {
    const given = req.headers["x-internal-token"];
    // Compare fixed-length hashes in constant time, so response timing reveals nothing
    // about how much of the secret a guess got right.
    if (typeof given !== "string" || !timingSafeEqual(digest(given), expected)) {
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Bad internal token" } });
      return;
    }
    next();
  };
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export interface InternalResponse<T> {
  status: number;
  body: T;
}

export interface InternalClient {
  post<T>(path: string, body: unknown, requestId?: string): Promise<InternalResponse<T>>;
}

const RETRY_DELAYS_MS = [200, 600];
const RETRYABLE_STATUS = new Set([502, 503, 504]);

// Calls another service: 3 s timeout, two retries on network errors and 502/503/504.
// Every internal endpoint is idempotent, which is what makes retrying safe. When retries
// run out, the caller gets 503 DEPENDENCY_UNAVAILABLE.
export function createInternalClient(baseUrl: string, internalToken: string, logger: Logger): InternalClient {
  return {
    async post<T>(path: string, body: unknown, requestId?: string): Promise<InternalResponse<T>> {
      for (let attempt = 0; ; attempt++) {
        let failure: string;
        try {
          const res = await fetch(new URL(path, baseUrl), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-internal-token": internalToken,
              ...(requestId ? { "x-request-id": requestId } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(3000),
          });
          if (!RETRYABLE_STATUS.has(res.status)) {
            return { status: res.status, body: (await res.json()) as T };
          }
          failure = `HTTP ${res.status}`;
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
        }

        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          logger.error({ path, requestId, failure }, "internal call failed after retries");
          throw new AppError("DEPENDENCY_UNAVAILABLE", "A service this request depends on is unavailable");
        }
        logger.warn({ path, requestId, failure, attempt: attempt + 1 }, "internal call failed, retrying");
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    },
  };
}
