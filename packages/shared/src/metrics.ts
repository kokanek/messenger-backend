import { collectDefaultMetrics, Histogram, Registry } from "@prometheus-io/client";
import type { RequestHandler } from "express";

// Services build their own Messenger counters on the same registry.
export { Counter, Gauge } from "@prometheus-io/client";

// One registry per service. Every metric carries a `service` label, the same name the
// logger puts on every log line, so a dashboard can line the two up.
export interface Metrics {
  registry: Registry;
  httpDuration: Histogram<"method" | "route" | "status_code">;
}

export function createMetrics(service: string): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  // Process and Node.js runtime metrics: memory, CPU, event loop lag, GC.
  collectDefaultMetrics({ register: registry });
  const httpDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "Time from request to response, by route template and status code.",
    labelNames: ["method", "route", "status_code"],
    registers: [registry],
  });
  return { registry, httpDuration };
}

const UNMEASURED = new Set(["/health", "/ready", "/metrics"]);

// Times every request. The route label is the template ("/api/conversations/:id/messages"),
// never the raw URL: each distinct label value is a new time series.
export function measureRequests(metrics: Metrics): RequestHandler {
  return (req, res, next) => {
    if (UNMEASURED.has(req.path)) return next();
    const end = metrics.httpDuration.startTimer();
    res.on("finish", () => {
      const route = req.route ? req.baseUrl + String(req.route.path) : "unmatched";
      end({ method: req.method, route, status_code: String(res.statusCode) });
    });
    next();
  };
}
