import { randomUUID } from "node:crypto";
import express, { type Express, type RequestHandler } from "express";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import { errorHandler, notFoundHandler } from "./errors.js";
import { measureRequests, type Metrics } from "./metrics.js";

// Each check answers "ok" or throws. /ready reports every check and returns 503 if any failed.
export type ReadinessChecks = Record<string, () => Promise<unknown>>;

export interface CreateAppOptions {
  logger: Logger;
  allowedOrigins: string[];
  readiness: ReadinessChecks;
  // Optional, so tests can build an app without metrics.
  metrics?: Metrics;
}

// The middleware every service starts with (backend spec, sections 7.1 and 11.4).
// Add routes to the returned app, then call finishApp(app).
export function createApp({ logger, allowedOrigins, readiness, metrics }: CreateAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use(
    pinoHttp({
      logger,
      // The gateway (nginx) sets X-Request-Id; generate one if a request didn't come through it.
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      customAttributeKeys: { reqId: "requestId", responseTime: "durationMs" },
      // Binds the id once, as `requestId`, on every line logged for this request. Without
      // it, pino-http ignores the reqId rename and our req serializer drops the id.
      quietReqLogger: true,
      serializers: {
        req: (req) => ({ method: req.method, path: req.url }),
        res: (res) => ({ status: res.statusCode }),
      },
      customProps: (req) => ({ userId: req.auth?.userId }),
      // Health checks run every few seconds; logging them would drown everything else.
      autoLogging: { ignore: (req) => req.url === "/health" || req.url === "/ready" },
    }),
  );

  if (metrics) app.use(measureRequests(metrics));

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(cors(allowedOrigins));
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/ready", async (_req, res) => {
    const checks: Record<string, "ok" | "down"> = {};
    await Promise.all(
      Object.entries(readiness).map(async ([name, check]) => {
        try {
          await withTimeout(check(), 1000);
          checks[name] = "ok";
        } catch {
          checks[name] = "down";
        }
      }),
    );
    const ok = Object.values(checks).every((value) => value === "ok");
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "unavailable", checks });
  });

  // Prometheus format, read by Alloy over the Compose network. The gateway doesn't route
  // /metrics, so it is never public.
  if (metrics) {
    app.get("/metrics", async (_req, res) => {
      res.setHeader("Content-Type", metrics.registry.contentType);
      res.send(await metrics.registry.metrics());
    });
  }

  return app;
}

// The id createApp gave this request, for forwarding on internal calls.
export const requestIdOf = (req: object): string => String((req as { id?: unknown }).id ?? "");

// 404 for unknown routes, then the error handler. Call after adding every route.
export function finishApp(app: Express): Express {
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

// A minimal CORS implementation: only the configured origins may call the API from a
// browser. Requests without an Origin header aren't affected.
function cors(allowedOrigins: string[]): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id");
        res.status(204).end();
        return;
      }
    }
    next();
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
