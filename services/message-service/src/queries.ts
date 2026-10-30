// The SQL from the backend spec, sections 10.2 to 10.7, copied as it was verified against
// Postgres. Each statement is one round trip. Comments give the $n parameters.

// Q-CREATE-HEAD: $1 conversation_id, $2 created_at. No row back means it already exists.
export const CREATE_HEAD = `
INSERT INTO conversation_heads (conversation_id, last_message_at) VALUES ($1, $2)
ON CONFLICT (conversation_id) DO NOTHING
RETURNING conversation_id`;

// Q-CREATE-MEMBERS: $1 conversation_id, $2 member ids (uuid[])
export const CREATE_MEMBERS = `
INSERT INTO conversation_members (conversation_id, user_id)
SELECT $1, m.user_id FROM unnest($2::uuid[]) AS m (user_id)
ON CONFLICT (conversation_id, user_id) DO NOTHING`;

// Q-MEMBERS: $1 conversation_id. No rows means the conversation doesn't exist.
export const MEMBERS = `
SELECT user_id FROM conversation_members WHERE conversation_id = $1`;

// Q-SEND: $1 conversation_id, $2 author_id, $3 author_name, $4 client_message_id, $5 text
export const SEND = `
WITH head AS (
  UPDATE conversation_heads
     SET last_seq = last_seq + 1, last_message_at = now()
   WHERE conversation_id = $1
  RETURNING conversation_id, last_seq, last_message_at
), msg AS (
  INSERT INTO messages (conversation_id, seq, author_id, author_name, client_message_id, text, created_at)
  SELECT conversation_id, last_seq, $2, $3, $4, $5, last_message_at FROM head
  RETURNING id, conversation_id, seq, author_id, author_name, client_message_id, text, created_at
), self_read AS (
  UPDATE conversation_members
     SET last_read_seq = GREATEST(last_read_seq, (SELECT seq FROM msg))
   WHERE conversation_id = $1 AND user_id = $2
)
SELECT * FROM msg`;

// Q-FIND-BY-CLIENT-MESSAGE-ID: $1 author_id, $2 client_message_id
export const FIND_BY_CLIENT_MESSAGE_ID = `
SELECT id, conversation_id, seq, author_id, author_name, client_message_id, text, created_at
FROM messages WHERE author_id = $1 AND client_message_id = $2`;

// Q-PAGE: $1 conversation_id, $2 cursor seq (NULL for the newest page), $3 limit + 1
export const PAGE = `
SELECT id, conversation_id, seq, author_id, author_name, client_message_id, text, created_at
FROM messages
WHERE conversation_id = $1 AND ($2::bigint IS NULL OR seq < $2)
ORDER BY seq DESC
LIMIT $3`;

// Q-READ: $1 conversation_id, $2 user_id, $3 seq
export const READ = `
UPDATE conversation_members m
   SET last_read_seq = GREATEST(m.last_read_seq, LEAST($3, h.last_seq))
  FROM conversation_heads h
 WHERE m.conversation_id = $1 AND m.user_id = $2 AND h.conversation_id = m.conversation_id
RETURNING m.last_read_seq`;

// Q-SUMMARIES: $1 user_id, $2 conversation ids (uuid[])
export const SUMMARIES = `
SELECT h.conversation_id,
       h.last_seq,
       h.last_message_at,
       mem.last_read_seq,
       h.last_seq - mem.last_read_seq AS unread,
       msg.id                    AS msg_id,
       msg.author_id             AS msg_author_id,
       msg.author_name           AS msg_author_name,
       msg.client_message_id     AS msg_client_message_id,
       msg.text                  AS msg_text,
       msg.created_at            AS msg_created_at
FROM conversation_heads h
JOIN conversation_members mem
  ON mem.conversation_id = h.conversation_id AND mem.user_id = $1
LEFT JOIN messages msg
  ON msg.conversation_id = h.conversation_id AND msg.seq = h.last_seq
WHERE h.conversation_id = ANY ($2::uuid[])
ORDER BY h.last_message_at DESC, h.conversation_id DESC`;
