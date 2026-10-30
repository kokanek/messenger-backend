import type { Logger, Redis, User } from "@messenger/shared";

const KEY = "cache:users";
const TTL_SECONDS = 300;

// Stage 2: cache-aside for GET /api/users (backend spec, section 14.3). The list is read on
// every app load and every time the new-conversation screen opens, but only changes when
// the admin creates a user. Redis is never the source of truth: if it's unreachable,
// every method quietly does nothing and the caller falls back to Postgres.
export class UserListCache {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  async get(): Promise<User[] | null> {
    try {
      const cached = await this.redis.get(KEY);
      return cached ? (JSON.parse(cached) as User[]) : null;
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, "user cache read failed");
      return null;
    }
  }

  async set(users: User[]): Promise<void> {
    try {
      await this.redis.set(KEY, JSON.stringify(users), "EX", TTL_SECONDS);
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, "user cache write failed");
    }
  }

  // After a new user is created, so the next read sees them.
  async clear(): Promise<void> {
    try {
      await this.redis.del(KEY);
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, "user cache clear failed");
    }
  }
}
