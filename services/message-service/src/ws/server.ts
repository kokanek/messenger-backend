import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { verifyAccessToken, type Gauge, type Logger } from "@messenger/shared";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { Broadcaster } from "../broadcaster.js";
import type { AuthedSocket, Registry } from "./registry.js";

// Close codes from the backend spec, section 8.4.
export const CLOSE_AUTH_FAILED = 4401;
export const CLOSE_SHUTTING_DOWN = 1001;
export const CLOSE_MALFORMED = 1008;

const AUTH_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 25_000;

export interface WsOptions {
  server: Server;
  registry: Registry;
  broadcaster: Broadcaster;
  jwtSecret: string;
  allowedOrigins: string[];
  logger: Logger;
  authTimeoutMs?: number; // tests shorten it
  // messenger_websocket_connections, when metrics are on.
  connections?: Gauge;
}

// The WebSocket is push-only: the client sends one `auth` frame, and from then on the
// server only sends events (backend spec, section 8).
export function attachWebSocketServer(options: WsOptions) {
  const { server, registry, broadcaster, jwtSecret, allowedOrigins, logger } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      return rejectUpgrade(socket, 404, "Not Found");
    }
    // Browsers always send Origin, so this stops other websites from opening a socket
    // with a user's token. Non-browser clients (tests, scripts) send none.
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
      return rejectUpgrade(socket, 403, "Forbidden");
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function onConnection(ws: WebSocket) {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    let authed: AuthedSocket | undefined;
    let authStarted = false;
    let counted = false; // in messenger_websocket_connections

    const authTimer = setTimeout(
      () => ws.close(CLOSE_AUTH_FAILED, "auth timeout"),
      options.authTimeoutMs ?? AUTH_TIMEOUT_MS,
    );

    ws.on("message", async (data: RawData) => {
      let frame: { type?: unknown; payload?: { token?: unknown } };
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return ws.close(authed ? CLOSE_MALFORMED : CLOSE_AUTH_FAILED, "malformed frame");
      }

      if (authed) {
        // Nothing else is accepted from clients in v1: sending goes over HTTP POST.
        ws.send(
          JSON.stringify({ type: "error", payload: { code: "UNSUPPORTED_FRAME", message: "Only auth is accepted" } }),
        );
        return;
      }

      // A second frame while the first is still being verified is also "before auth".
      if (authStarted) return ws.close(CLOSE_AUTH_FAILED, "first frame must be auth");
      authStarted = true;
      clearTimeout(authTimer);
      const token = frame.type === "auth" ? frame.payload?.token : undefined;
      if (typeof token !== "string") return ws.close(CLOSE_AUTH_FAILED, "first frame must be auth");
      try {
        const auth = await verifyAccessToken(jwtSecret, token);
        authed = { ws, userId: auth.userId, clientId: auth.clientId };
      } catch {
        return ws.close(CLOSE_AUTH_FAILED, "invalid token");
      }
      if (ws.readyState !== ws.OPEN) return;
      // Counted only once authenticated; the close handler takes it off again.
      options.connections?.inc();
      counted = true;
      // Subscribe before saying ready, so no message published after `ready` is missed.
      if (registry.add(authed)) await broadcaster.userConnected?.(authed.userId);
      ws.send(
        JSON.stringify({ type: "ready", payload: { userId: authed.userId, serverTime: new Date().toISOString() } }),
      );
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (counted) options.connections?.dec();
      if (authed && registry.remove(authed)) {
        broadcaster.userDisconnected?.(authed.userId).catch((err: Error) => {
          logger.warn({ err: err.message }, "unsubscribe failed");
        });
      }
    });
    ws.on("error", (err) => logger.warn({ err: err.message }, "websocket error"));
  }

  // Heartbeat: ping every 25 s, and drop a socket that didn't answer the previous ping
  // (a phone that lost signal never sends a close frame).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref();

  return {
    // On shutdown: tell every client to reconnect (to another instance, or after restart).
    closeAll() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(CLOSE_SHUTTING_DOWN, "server shutting down");
    },
  };
}

function rejectUpgrade(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
