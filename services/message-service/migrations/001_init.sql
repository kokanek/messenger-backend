CREATE TABLE conversation_heads (
  conversation_id UUID PRIMARY KEY,
  last_seq        BIGINT NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ NOT NULL
);

-- Filled once, when the conversation is created. Members never change.
CREATE TABLE conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversation_heads (conversation_id),
  user_id         UUID NOT NULL,
  last_read_seq   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE messages (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id   UUID NOT NULL REFERENCES conversation_heads (conversation_id),
  seq               BIGINT NOT NULL,
  author_id         UUID NOT NULL,
  author_name       TEXT NOT NULL,
  client_message_id UUID NOT NULL,
  text              TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq),
  UNIQUE (author_id, client_message_id)
);
