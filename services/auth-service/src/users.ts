import type { User } from "@messenger/shared";
import { hash } from "@node-rs/argon2";
import type { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: "admin" | "member";
}

export const toUser = (row: Pick<UserRow, "id" | "username" | "display_name" | "role">): User => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  role: row.role,
});

export async function findUserByUsername(pool: Pool, username: string): Promise<UserRow | undefined> {
  const { rows } = await pool.query<UserRow>(
    "SELECT id, username, password_hash, display_name, role FROM users WHERE username = $1",
    [username],
  );
  return rows[0];
}

export interface NewUser {
  username: string;
  password: string;
  displayName: string;
  role: "admin" | "member";
  createdBy: string | null;
}

// argon2id with the library's defaults. Hashing is deliberately slow, which is what
// makes guessing passwords from a stolen database expensive.
export async function insertUser(pool: Pool, user: NewUser): Promise<User> {
  const passwordHash = await hash(user.password);
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (id, username, password_hash, display_name, role, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, username, password_hash, display_name, role`,
    [uuidv7(), user.username, passwordHash, user.displayName, user.role, user.createdBy],
  );
  return toUser(rows[0]!);
}

export async function listUsers(pool: Pool): Promise<User[]> {
  const { rows } = await pool.query<UserRow>(
    "SELECT id, username, display_name, role FROM users ORDER BY display_name, id",
  );
  return rows.map(toUser);
}
