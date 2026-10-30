import type { Server } from "node:http";
import type { Logger } from "pino";

// Databases may still be starting when a service starts (compose starts containers in
// parallel), so connect with backoff for up to 30 s before giving up (section 11.2).
export async function connectWithRetry<T>(label: string, connect: () => Promise<T>, logger: Logger): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (let delay = 250; ; delay = Math.min(delay * 2, 4000)) {
    try {
      return await connect();
    } catch (err) {
      if (Date.now() + delay > deadline) throw err;
      logger.warn({ err: (err as Error).message, retryInMs: delay }, `${label} not reachable yet`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export interface ShutdownOptions {
  server: Server;
  logger: Logger;
  // Runs right after the server stops accepting connections (e.g. close WebSockets).
  beforeDrain?: () => void;
  // Runs after in-flight requests finish (e.g. close database pools).
  close: () => Promise<void>;
}

// On SIGTERM or SIGINT: stop accepting connections, let in-flight requests finish
// (10 s at most), close pools, exit 0.
export function handleShutdown({ server, logger, beforeDrain, close }: ShutdownOptions): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const drained = new Promise<void>((resolve) => server.close(() => resolve()));
    beforeDrain?.();
    server.closeIdleConnections();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref());
    await Promise.race([drained, timeout]);
    server.closeAllConnections();

    try {
      await close();
    } catch (err) {
      logger.error({ err }, "error while closing");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
