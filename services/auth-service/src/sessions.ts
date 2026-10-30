import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

// A "client" is one logged-in device. Its refresh token is `<clientId>.<secret>`, returned
// in the login and refresh responses; the app keeps it in localStorage and sends it back
// in the body of POST /api/auth/refresh. The database keeps only sha256(secret), so a
// database leak doesn't leak usable tokens (backend spec, section 10.1).

export const newSecret = () => randomBytes(32).toString("base64url");
export const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

export function secretMatches(secret: string, storedHash: string): boolean {
  return timingSafeEqual(Buffer.from(hashSecret(secret), "hex"), Buffer.from(storedHash, "hex"));
}

export const formatRefreshToken = (clientId: string, secret: string) => `${clientId}.${secret}`;

// Splits `<clientId>.<secret>`. Returns null for anything that isn't shaped like one.
export function parseRefreshToken(token: string): { clientId: string; secret: string } | null {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  return { clientId: token.slice(0, dot), secret: token.slice(dot + 1) };
}

export async function createClient(pool: Pool, userId: string, ttlDays: number) {
  const clientId = uuidv7();
  const secret = newSecret();
  await pool.query(
    `INSERT INTO clients (id, user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [clientId, userId, hashSecret(secret), ttlDays],
  );
  return { clientId, secret };
}

// Logout and refresh-token reuse both end here. Only the refresh token stops working;
// an access token already handed out stays valid until it expires (at most 15 minutes).
export async function revokeClient(pool: Pool, clientId: string): Promise<void> {
  await pool.query("UPDATE clients SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [clientId]);
}
