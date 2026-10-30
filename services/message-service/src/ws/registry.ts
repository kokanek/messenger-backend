import type { WebSocket } from "ws";

// A socket that has sent a valid auth frame.
export interface AuthedSocket {
  ws: WebSocket;
  userId: string;
  clientId: string;
}

// If the server can't push to a client fast enough, its unsent data piles up in memory.
// Past this point we drop the connection; the client reconnects and refetches.
const MAX_BUFFERED_BYTES = 1024 * 1024;

// Who is connected to this process: userId -> that user's open sockets (one per device).
export class Registry {
  private readonly sockets = new Map<string, Set<AuthedSocket>>();

  // Returns true if this is the user's first socket on this process.
  add(socket: AuthedSocket): boolean {
    let set = this.sockets.get(socket.userId);
    const first = !set;
    if (!set) {
      set = new Set();
      this.sockets.set(socket.userId, set);
    }
    set.add(socket);
    return first;
  }

  // Returns true if that was the user's last socket on this process.
  remove(socket: AuthedSocket): boolean {
    const set = this.sockets.get(socket.userId);
    if (!set) return false;
    set.delete(socket);
    if (set.size > 0) return false;
    this.sockets.delete(socket.userId);
    return true;
  }

  sendToUser(userId: string, data: string): void {
    for (const socket of this.sockets.get(userId) ?? []) {
      if (socket.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        socket.ws.terminate();
        continue;
      }
      socket.ws.send(data);
    }
  }

  all(): AuthedSocket[] {
    return [...this.sockets.values()].flatMap((set) => [...set]);
  }
}
