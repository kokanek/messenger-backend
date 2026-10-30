import type { ConversationSummary, Summary } from "@messenger/shared";
import type { Collection, Db } from "mongodb";

// One document per conversation in MongoDB (backend spec, section 6.3).
export interface ConversationDoc {
  _id: string; // UUIDv7
  type: "direct" | "group";
  name: string | null; // null for direct
  createdBy: string;
  createdAt: Date;
  memberIds: string[]; // includes the creator; never changes
  dmKey: string | null; // direct only: both user ids sorted and joined with ":"
}

export const conversations = (db: Db): Collection<ConversationDoc> => db.collection<ConversationDoc>("conversations");

// Safe to run on every startup: creating an index that already exists does nothing.
export async function ensureIndexes(collection: Collection<ConversationDoc>): Promise<void> {
  // "Which conversations is this user in?" for the conversation list.
  await collection.createIndex({ memberIds: 1 });
  // At most one direct conversation per pair of users, even if both create it at once.
  // Partial: group conversations all have dmKey null and must not collide on it.
  await collection.createIndex({ dmKey: 1 }, { unique: true, partialFilterExpression: { dmKey: { $type: "string" } } });
}

export const dmKeyFor = (a: string, b: string) => [a, b].sort().join(":");

// Merges the MongoDB half of a list row (name, type, members) with message-service's
// half (last message, unread). A conversation with no summary yet has no messages.
export function toSummary(doc: ConversationDoc, summary?: Summary): ConversationSummary {
  return {
    id: doc._id,
    type: doc.type,
    isGroup: doc.type === "group",
    name: doc.name,
    memberIds: doc.memberIds,
    lastSeq: summary?.lastSeq ?? 0,
    lastReadSeq: summary?.lastReadSeq ?? 0,
    unread: summary?.unread ?? 0,
    lastMessage: summary?.lastMessage ?? null,
    lastMessageAt: summary?.lastMessageAt ?? doc.createdAt.toISOString(),
  };
}
