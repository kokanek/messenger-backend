import type { Logger } from "@messenger/shared";
import type { Pool } from "pg";
import { insertUser } from "./users.js";

// There's no signup, so someone has to exist to create the first users. On startup, if
// there is no admin yet, create one from ADMIN_USERNAME and ADMIN_PASSWORD. It never
// overwrites an existing user and never changes a password (backend spec, section 10.1).
export async function ensureAdmin(
  pool: Pool,
  username: string | undefined,
  password: string | undefined,
  logger: Logger,
): Promise<void> {
  const { rows } = await pool.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");
  if (rows.length > 0) {
    logger.info("admin exists, bootstrap skipped");
    return;
  }
  if (!username || !password) {
    logger.warn("no admin exists and ADMIN_USERNAME / ADMIN_PASSWORD are not set");
    return;
  }
  const name = username.toLowerCase();
  const taken = await pool.query("SELECT 1 FROM users WHERE username = $1", [name]);
  if (taken.rows.length > 0) {
    logger.warn({ username: name }, "ADMIN_USERNAME belongs to an existing member; not changing it");
    return;
  }
  await insertUser(pool, { username: name, password, displayName: "Admin", role: "admin", createdBy: null });
  logger.info({ username: name }, "admin created");
}
