import { AppError, requireAuth, signAccessToken, type LoginResponse, type User } from "@messenger/shared";
import { hash, verify } from "@node-rs/argon2";
import { Router, type Response } from "express";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import {
  createClient,
  formatRefreshToken,
  hashSecret,
  newSecret,
  parseRefreshToken,
  revokeClient,
  secretMatches,
} from "../sessions.js";
import { findUserByUsername, toUser } from "../users.js";

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

const refreshBody = z.object({ refreshToken: z.string().min(1).max(200) });

export function authRoutes({ pool, config, logger }: AppDeps): Router {
  const router = Router();
  // Checked against when the username doesn't exist, so a wrong username takes as long
  // as a wrong password and response times don't reveal which usernames exist.
  const dummyHash = hash("not-a-real-password");

  async function sendTokens(res: Response, user: User, clientId: string, secret: string) {
    const accessToken = await signAccessToken(
      config.JWT_SECRET,
      { userId: user.id, clientId, role: user.role, displayName: user.displayName },
      config.ACCESS_TOKEN_TTL_SECONDS,
    );
    const body: LoginResponse = {
      accessToken,
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: formatRefreshToken(clientId, secret),
      user,
    };
    res.json(body);
  }

  router.post("/api/auth/login", async (req, res) => {
    const { username, password } = loginBody.parse(req.body);
    const row = await findUserByUsername(pool, username.toLowerCase());
    const passwordOk = await verify(row?.password_hash ?? (await dummyHash), password);
    if (!row || !passwordOk) {
      throw new AppError("INVALID_CREDENTIALS", "Wrong username or password");
    }
    const { clientId, secret } = await createClient(pool, row.id, config.REFRESH_TOKEN_TTL_DAYS);
    await sendTokens(res, toUser(row), clientId, secret);
  });

  router.post("/api/auth/refresh", async (req, res) => {
    const invalid = () => new AppError("REFRESH_INVALID", "Log in again");

    const parsed = parseRefreshToken(refreshBody.parse(req.body).refreshToken);
    if (!parsed || !z.uuid().safeParse(parsed.clientId).success) throw invalid();
    const { clientId, secret } = parsed;

    const { rows } = await pool.query<{
      refresh_token_hash: string;
      usable: boolean;
      user_id: string;
      username: string;
      display_name: string;
      role: "admin" | "member";
    }>(
      `SELECT c.refresh_token_hash,
              c.revoked_at IS NULL AND c.expires_at > now() AS usable,
              u.id AS user_id, u.username, u.display_name, u.role
       FROM clients c JOIN users u ON u.id = c.user_id
       WHERE c.id = $1`,
      [clientId],
    );
    const row = rows[0];
    if (!row || !row.usable) throw invalid();

    if (!secretMatches(secret, row.refresh_token_hash)) {
      // A real client id with an old secret: this token was already rotated, so someone
      // may be replaying a stolen copy. Log the device out rather than guess who's who.
      await revokeClient(pool, clientId);
      logger.warn({ clientId, userId: row.user_id }, "refresh token reuse, client revoked");
      throw invalid();
    }

    // Rotate. The WHERE on the old hash makes this a compare-and-swap: if two refreshes
    // with the same token race, only one wins and the other gets 401.
    const fresh = newSecret();
    const rotated = await pool.query(
      `UPDATE clients
          SET refresh_token_hash = $2, expires_at = now() + make_interval(days => $4)
        WHERE id = $1 AND refresh_token_hash = $3 AND revoked_at IS NULL`,
      [clientId, hashSecret(fresh), row.refresh_token_hash, config.REFRESH_TOKEN_TTL_DAYS],
    );
    if (rotated.rowCount !== 1) throw invalid();

    const user = toUser({ id: row.user_id, username: row.username, display_name: row.display_name, role: row.role });
    await sendTokens(res, user, clientId, fresh);
  });

  router.post("/api/auth/logout", requireAuth(config.JWT_SECRET), async (req, res) => {
    await revokeClient(pool, req.auth!.clientId);
    res.status(204).end();
  });

  return router;
}
