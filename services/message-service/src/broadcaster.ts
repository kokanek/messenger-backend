import type { Redis, ServerEvent } from "@messenger/shared";
import type { Registry } from "./ws/registry.js";

// Delivers one event to every connected device of each user (backend spec, section 10.8).
// The send code only ever talks to this interface, so stage 2 can swap in a Redis-based
// implementation without touching it.
export interface Broadcaster {
  publish(userIds: string[], event: ServerEvent): Promise<void>;
  // Called when a user's first socket connects to this process, and when their last one
  // closes. Stage 2 uses them to subscribe to that user's Redis channel.
  userConnected?(userId: string): Promise<void>;
  userDisconnected?(userId: string): Promise<void>;
}

// Stage 1: look each user up in this process's registry and write to their sockets.
// Correct only while there is exactly one message-service process, because a device
// connected to another process isn't in this registry.
export class LocalBroadcaster implements Broadcaster {
  constructor(private readonly registry: Registry) {}

  async publish(userIds: string[], event: ServerEvent): Promise<void> {
    const data = JSON.stringify(event);
    for (const userId of userIds) {
      this.registry.sendToUser(userId, data);
    }
  }
}

// Stage 2: delivery across several message-service processes (backend spec, section 14.2).
// Each process subscribes to `user:{id}` for every user with a socket on it, and a send
// publishes to the channel of every member. Redis passes each message to every process
// subscribed to that channel, and each one writes it to its own sockets. The process
// that published gets its own message back the same way, so there's no special local path.
// Redis pub/sub doesn't store anything: a message nobody is subscribed to is dropped.
// That's fine, because it's already in Postgres and clients refetch on reconnect.
export class RedisBroadcaster implements Broadcaster {
  constructor(
    private readonly publisher: Redis,
    // A connection in subscriber mode can't run other commands, hence two connections.
    private readonly subscriber: Redis,
    registry: Registry,
  ) {
    subscriber.on("message", (channel: string, message: string) => {
      registry.sendToUser(channel.slice(CHANNEL_PREFIX.length), message);
    });
  }

  async publish(userIds: string[], event: ServerEvent): Promise<void> {
    const data = JSON.stringify(event);
    const pipeline = this.publisher.pipeline(); // one round trip for every member
    for (const userId of userIds) pipeline.publish(CHANNEL_PREFIX + userId, data);
    await pipeline.exec();
  }

  async userConnected(userId: string): Promise<void> {
    await this.subscriber.subscribe(CHANNEL_PREFIX + userId);
  }

  async userDisconnected(userId: string): Promise<void> {
    await this.subscriber.unsubscribe(CHANNEL_PREFIX + userId);
  }
}

const CHANNEL_PREFIX = "user:";
