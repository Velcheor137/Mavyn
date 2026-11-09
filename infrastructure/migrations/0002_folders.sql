-- Folder tree of a server library. `parent_id` NULL means the library root. Folders share the
-- document change sequence so one cursor covers both in the change feed.

CREATE TABLE folders (
    id         uuid PRIMARY KEY,
    library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    parent_id  uuid,
    name       text NOT NULL,
    change_seq bigint NOT NULL DEFAULT nextval('change_seq'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE INDEX folders_library_seq_idx ON folders(library_id, change_seq);
CREATE INDEX folders_parent_idx ON folders(library_id, parent_id) WHERE deleted_at IS NULL;
CREATE INDEX documents_folder_idx ON documents(folder_id) WHERE deleted_at IS NULL;
