-- API keys ("mvn_…") for scripts and MCP clients. Only server administrators create them, for
-- themselves; a key acts as its owner, capped by its own scope (libraries, read/write, delete).

CREATE TABLE api_tokens (
    id            uuid PRIMARY KEY,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    -- SHA-256 of the key; the key itself is shown once and never stored.
    token_hash    bytea NOT NULL UNIQUE,
    -- Last four characters, so the owner can tell keys apart.
    hint          text NOT NULL,
    access        text NOT NULL CHECK (access IN ('read', 'write')),
    can_delete    boolean NOT NULL DEFAULT false CHECK (NOT can_delete OR access = 'write'),
    -- true: every library the owner is a member of, including future ones.
    all_libraries boolean NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz,
    -- NULL: no expiry (until revoked).
    expires_at    timestamptz,
    revoked_at    timestamptz
);
CREATE INDEX api_tokens_user_idx ON api_tokens(user_id);

CREATE TABLE api_token_libraries (
    token_id   uuid NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
    library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    PRIMARY KEY (token_id, library_id)
);
