// The public API's data shapes (backend spec, section 7.2). The frontend mirrors these.
// Dates are ISO 8601 strings in UTC, as produced by Date.prototype.toISOString().

export type Role = "admin" | "member";

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

export interface LoginResponse {
  accessToken: string; // short-lived: send as Authorization: Bearer <accessToken>
  expiresIn: number; // seconds
  refreshToken: string; // long-lived: send to POST /api/auth/refresh for a new pair
  user: User;
}

export interface Message {
  id: string; // database id, as a string
  conversationId: string;
  seq: number; // 1, 2, 3... within the conversation, no gaps
  authorId: string;
  authorName: string; // display name at send time
  clientMessageId: string; // the sender's idempotency key
  text: string;
  createdAt: string;
}

// GET /api/conversations/:id/messages[?cursor=]
export interface MessagesPage {
  messages: Message[]; // oldest first
  nextCursor: string | null; // pass as ?cursor= to get older messages; null when there are none
}

// One row of the conversation list.
export interface ConversationSummary {
  id: string;
  type: "direct" | "group";
  isGroup: boolean; // type === "group"; kept for the existing UI
  name: string | null; // group name; null for direct (show the other member's displayName)
  memberIds: string[]; // includes the caller
  lastSeq: number;
  lastReadSeq: number;
  unread: number; // lastSeq - lastReadSeq
  lastMessage: Message | null;
  lastMessageAt: string; // last message time, or creation time if there are no messages
}

// Internal API (section 9): message-service's half of a conversation summary.
export interface Summary {
  conversationId: string;
  lastSeq: number;
  lastReadSeq: number;
  unread: number;
  lastMessageAt: string;
  lastMessage: Message | null;
}

// Every WebSocket frame, in both directions, has this envelope (section 8.1).
export interface ServerEvent<T = unknown> {
  type: string;
  payload: T;
}
