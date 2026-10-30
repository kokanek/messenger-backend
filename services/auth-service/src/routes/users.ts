import { AppError, requireAdmin, requireAuth } from "@messenger/shared";
import { Router } from "express";
import { DatabaseError } from "pg";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { insertUser, listUsers } from "../users.js";

const createUserBody = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{3,32}$/, "3 to 32 characters: lowercase letters, digits and _"),
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(1).max(64),
  role: z.enum(["admin", "member"]).default("member"),
});

export function userRoutes({ pool, config, userCache }: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(config.JWT_SECRET);

  // Only an admin creates users: there is no self-signup.
  router.post("/api/users", auth, requireAdmin, async (req, res) => {
    const body = createUserBody.parse(req.body);
    try {
      const user = await insertUser(pool, { ...body, createdBy: req.auth!.userId });
      await userCache?.clear();
      res.status(201).json(user);
    } catch (err) {
      if (err instanceof DatabaseError && err.code === "23505") {
        throw new AppError("USERNAME_TAKEN", "That username is already taken");
      }
      throw err;
    }
  });

  // Every user, for the new-conversation picker and for showing names. At ~50 users the
  // browser can search and filter this list itself, so there's no search endpoint.
  router.get("/api/users", auth, async (_req, res) => {
    const cached = await userCache?.get();
    if (cached) return void res.json(cached);
    const users = await listUsers(pool);
    await userCache?.set(users);
    res.json(users);
  });

  return router;
}
