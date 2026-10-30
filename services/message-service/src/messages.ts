import { AppError, type Message } from "@messenger/shared";
import { DatabaseError, type Pool } from "pg";
import { FIND_BY_CLIENT_MESSAGE_ID, MEMBERS, SEND } from "./queries.js";

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: string; // pg returns BIGINT as a string
  author_id: string;
  author_name: string;
  client_message_id: string;
  text: string;
  created_at: Date;
}

export const toMessage = (row: MessageRow): Message => ({
  id: String(row.id),
  conversationId: row.conversation_id,
  seq: Number(row.seq),
  authorId: row.author_id,
  authorName: row.author_name,
  clientMessageId: row.client_message_id,
  text: row.text,
  createdAt: row.created_at.toISOString(),
});

// Returns the members of a conversation, after checking the caller is one of them
// (backend spec, section 10.3). The same list is who receives a new message.
export async function requireMember(pool: Pool, conversationId: string, userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ user_id: string }>(MEMBERS, [conversationId]);
  // Every registered conversation has at least 2 members and nobody is ever removed,
  // so no rows means the conversation doesn't exist.
  if (rows.length === 0) throw new AppError("NOT_FOUND", "No such conversation");
  const memberIds = rows.map((r) => r.user_id);
  if (!memberIds.includes(userId)) throw new AppError("NOT_A_MEMBER", "You are not a member of this conversation");
  return memberIds;
}

export interface NewMessage {
  conversationId: string;
  authorId: string;
  authorName: string;
  clientMessageId: string;
  text: string;
}

// Stores one message (section 10.4). `created` is false when this clientMessageId was already
// used in this conversation: a retry of a send that succeeded, so nothing new is stored.
export async function storeMessage(pool: Pool, input: NewMessage): Promise<{ message: Message; created: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The UPDATE on conversation_heads inside Q-SEND locks this conversation's row until
    // COMMIT, so concurrent sends queue up and get consecutive seq numbers.
    const { rows } = await client.query<MessageRow>(SEND, [
      input.conversationId,
      input.authorId,
      input.authorName,
      input.clientMessageId,
      input.text,
    ]);
    await client.query("COMMIT");
    return { message: toMessage(rows[0]!), created: true };
  } catch (err) {
    await client.query("ROLLBACK");
    // Unique (author_id, client_message_id): this send was already stored. The rollback also
    // undoes the last_seq bump, so no seq number is wasted.
    if (
      err instanceof DatabaseError &&
      err.code === "23505" &&
      err.constraint === "messages_author_id_client_message_id_key"
    ) {
      const { rows } = await pool.query<MessageRow>(FIND_BY_CLIENT_MESSAGE_ID, [input.authorId, input.clientMessageId]);
      const existing = rows[0]!;
      if (existing.conversation_id !== input.conversationId) {
        throw new AppError(
          "CLIENT_MESSAGE_ID_REUSED",
          "This clientMessageId was already used for a message in another conversation",
        );
      }
      return { message: toMessage(existing), created: false };
    }
    throw err;
  } finally {
    client.release();
  }
}
