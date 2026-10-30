CREATE TABLE users (
  id            UUID PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_]{3,32}$'),
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 64),
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_by    UUID REFERENCES users (id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per login (device). The refresh token is stored only as a hash.
CREATE TABLE clients (
  id                 UUID PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES users (id),
  refresh_token_hash TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ
);
