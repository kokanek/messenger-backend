import { requireInternal, type Message, type Summary } from "@messenger/shared";
import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { CREATE_HEAD, CREATE_MEMBERS, SUMMARIES } from "../queries.js";

const registerBody = z.object({
  id: z.uuid(),
  type: z.enum(["direct", "group"]),
  memberIds: z.array(z.uuid()).min(2).max(256),
  createdAt: z.iso.datetime(),
});

const summariesBody = z.object({
  userId: z.uuid(),
  conversationIds: z.array(z.uuid()).max(500),
});

interface SummaryRow {
  conversation_id: string;
  last_seq: string;
  last_message_at: Date;
  last_read_seq: string;
  unread: string;
  msg_id: string | null;
  msg_author_id: string;
  msg_author_name: string;
  msg_client_message_id: string;
  msg_text: string;
  msg_created_at: Date;
}

// Called only by conversation-service (backend spec, section 9).
export function internalRoutes({ pool, config }: AppDeps): Router {
  const router = Router();
  router.use("/internal", requireInternal(config.INTERNAL_TOKEN));

  // "This conversation exists, and these are its members." Members never change, so
  // message-service keeps its own copy and never has to ask conversation-service again.
  // Both inserts skip rows that already exist, so a retried call changes nothing.
  router.post("/internal/conversations", async (req, res) => {
    const { id, memberIds, createdAt } = registerBody.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const head = await client.query(CREATE_HEAD, [id, createdAt]);
      const created = head.rowCount === 1;
      if (created) await client.query(CREATE_MEMBERS, [id, memberIds]);
      await client.query("COMMIT");
      res.json({ created });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  // The message half of each conversation-list row: last message, unread count, and the
  // order by latest activity. conversation-service merges in names (section 10.7).
  router.post("/internal/summaries", async (req, res) => {
    const { userId, conversationIds } = summariesBody.parse(req.body);
    const { rows } = await pool.query<SummaryRow>(SUMMARIES, [userId, conversationIds]);
    const items: Summary[] = rows.map((row) => ({
      conversationId: row.conversation_id,
      lastSeq: Number(row.last_seq),
      lastReadSeq: Number(row.last_read_seq),
      unread: Number(row.unread),
      lastMessageAt: row.last_message_at.toISOString(),
      lastMessage: row.msg_id === null ? null : summaryMessage(row),
    }));
    res.json({ items });
  });

  return router;
}

const summaryMessage = (row: SummaryRow): Message => ({
  id: String(row.msg_id),
  conversationId: row.conversation_id,
  seq: Number(row.last_seq), // the last message is the one at last_seq
  authorId: row.msg_author_id,
  authorName: row.msg_author_name,
  clientMessageId: row.msg_client_message_id,
  text: row.msg_text,
  createdAt: row.msg_created_at.toISOString(),
});
