import { AppError, requireAuth, type MessagesPage } from "@messenger/shared";
import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { requireMember, storeMessage, toMessage, type MessageRow } from "../messages.js";
import { PAGE, READ } from "../queries.js";

const params = z.object({ id: z.uuid() });

const historyQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const sendBody = z.object({
  clientMessageId: z.uuid(),
  // Count characters the way Postgres's char_length does (code points, not UTF-16 units).
  text: z
    .string()
    .refine((text) => text.trim().length > 0, "Text can't be empty")
    .refine((text) => [...text].length <= 4000, "At most 4000 characters"),
});

const readBody = z.object({ seq: z.number().int().min(0) });

export function messageRoutes({ pool, config, broadcaster, metrics }: AppDeps): Router {
  const router = Router();
  router.use("/api/conversations", requireAuth(config.JWT_SECRET));

  // History, newest page first. Each page is oldest first; nextCursor is the seq of the
  // oldest message in the page when older ones exist (backend spec, section 10.5).
  router.get("/api/conversations/:id/messages", async (req, res) => {
    const { id } = params.parse(req.params);
    const { cursor, limit } = historyQuery.parse(req.query);
    if (cursor !== undefined && !/^[1-9]\d{0,17}$/.test(cursor)) {
      throw new AppError("INVALID_CURSOR", "cursor must be a nextCursor from a previous page");
    }
    await requireMember(pool, id, req.auth!.userId);

    // Fetch one extra row: if it comes back, there are older messages.
    const { rows } = await pool.query<MessageRow>(PAGE, [id, cursor ?? null, limit + 1]);
    const hasOlder = rows.length > limit;
    const messages = rows.slice(0, limit).reverse().map(toMessage);
    const page: MessagesPage = {
      messages,
      nextCursor: hasOlder ? String(messages[0]!.seq) : null,
    };
    res.json(page);
  });

  router.post("/api/conversations/:id/messages", async (req, res) => {
    const { id } = params.parse(req.params);
    const { clientMessageId, text } = sendBody.parse(req.body);
    const auth = req.auth!;
    const memberIds = await requireMember(pool, id, auth.userId);

    const { message, created } = await storeMessage(pool, {
      conversationId: id,
      authorId: auth.userId,
      authorName: auth.displayName,
      clientMessageId,
      text,
    });
    if (created) {
      metrics?.messagesSent.inc();
      // Only after COMMIT: a pushed message is always one that is really stored.
      // Every member gets it, including the author, whose other devices need it too.
      await broadcaster.publish(memberIds, { type: "message.created", payload: message });
    }
    res.status(created ? 201 : 200).json(message);
  });

  router.post("/api/conversations/:id/read", async (req, res) => {
    const { id } = params.parse(req.params);
    const { seq } = readBody.parse(req.body);
    await requireMember(pool, id, req.auth!.userId);
    const { rows } = await pool.query<{ last_read_seq: string }>(READ, [id, req.auth!.userId, seq]);
    res.json({ conversationId: id, lastReadSeq: Number(rows[0]!.last_read_seq) });
  });

  return router;
}
