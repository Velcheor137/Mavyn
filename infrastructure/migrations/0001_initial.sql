-- Initial schema. Migrations are append-only: never edit an applied migration, add a new one.

CREATE TABLE users (
    id            uuid PRIMARY KEY,
    username      text NOT NULL,
    -- NFC + lowercase, for case-insensitive uniqueness ("Admin" == "admin").
    username_key  text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    is_admin      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Single row. The setup token exists only until the first admin is created.
CREATE TABLE setup_state (
    id           boolean PRIMARY KEY DEFAULT true CHECK (id),
    token_hash   bytea,
    completed_at timestamptz
);

CREATE TABLE sessions (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- SHA-256 of the bearer token; the token itself is never stored.
    token_hash   bytea NOT NULL UNIQUE,
    csrf_token   text NOT NULL,
    device_name  text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE libraries (
    id         uuid PRIMARY KEY,
    name       text NOT NULL,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE library_members (
    library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
    PRIMARY KEY (library_id, user_id)
);
CREATE INDEX library_members_user_idx ON library_members(user_id);

-- Content-addressed document text (sha-256 hex of UTF-8), deduplicated across revisions.
CREATE TABLE blobs (
    hash    text PRIMARY KEY,
    size    bigint NOT NULL,
    content text NOT NULL
);

-- Monotonic across the server; drives the cursor-based change feed.
CREATE SEQUENCE change_seq;

CREATE TABLE documents (
    id               uuid PRIMARY KEY,
    library_id       uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    folder_id        uuid,
    title            text NOT NULL,
    file_name        text NOT NULL,
    head_revision_id uuid NOT NULL,
    content_hash     text NOT NULL REFERENCES blobs(hash),
    change_seq       bigint NOT NULL DEFAULT nextval('change_seq'),
    search           tsvector NOT NULL DEFAULT ''::tsvector,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz
);
CREATE INDEX documents_library_seq_idx ON documents(library_id, change_seq);
CREATE INDEX documents_search_idx ON documents USING gin(search);

CREATE TABLE revisions (
    id                 uuid PRIMARY KEY,
    document_id        uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parent_revision_id uuid,
    content_hash       text NOT NULL REFERENCES blobs(hash),
    author_id          uuid REFERENCES users(id) ON DELETE SET NULL,
    reason             text NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX revisions_document_idx ON revisions(document_id, created_at DESC);

-- Idempotency: a retried operation with the same key returns the stored response.
CREATE TABLE applied_ops (
    op_id      uuid NOT NULL,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status     smallint NOT NULL,
    response   jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, op_id)
);
