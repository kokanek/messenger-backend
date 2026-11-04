import { Counter, createMetrics, type Metrics } from "@messenger/shared";

// auth-service's metrics: the shared HTTP and runtime metrics, plus two Messenger counters.
// Label values are a fixed set, never a username or user id (observability spec, section 3).
export interface AuthMetrics extends Metrics {
  logins: Counter<"result">;
  userCache: Counter<"result">;
}

export function createAuthMetrics(): AuthMetrics {
  const metrics = createMetrics("auth-service");
  return {
    ...metrics,
    logins: new Counter({
      name: "messenger_logins_total",
      help: "Login attempts, by result (success or invalid_credentials).",
      labelNames: ["result"],
      registers: [metrics.registry],
    }),
    userCache: new Counter({
      name: "messenger_user_cache_requests_total",
      help: "Reads of the cached user list, by result (hit, miss or error).",
      labelNames: ["result"],
      registers: [metrics.registry],
    }),
  };
}
