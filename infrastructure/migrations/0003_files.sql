-- Binary ("file") documents: docx/xlsx/ods/pdf, view-only. Their bytes are set once at upload and
-- never change; they have exactly one revision and are searched by title only (ADR-007 in
-- docs/architecture.md §7, "Binary documents").

ALTER TABLE documents
    ADD COLUMN kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'file')),
    ADD COLUMN mime text NULL;
-- Files always carry a MIME type, text documents never do.
ALTER TABLE documents
    ADD CONSTRAINT documents_kind_mime_check CHECK ((kind = 'file') = (mime IS NOT NULL));

-- Content-addressed file bytes (sha-256 hex of the bytes), kept in PostgreSQL next to `blobs`.
CREATE TABLE file_blobs (
    hash  text PRIMARY KEY,
    size  bigint NOT NULL,
    mime  text NOT NULL,
    bytes bytea NOT NULL
);

-- `content_hash` now points into `blobs` (text) or `file_blobs` (files) depending on the document
-- kind. A foreign key cannot target two tables, so the FKs are replaced by triggers that keep the
-- same guarantee on insert/update. Blobs are never deleted yet; whoever adds blob garbage collection
-- must delete only hashes no document or revision references (both tables).
ALTER TABLE documents DROP CONSTRAINT documents_content_hash_fkey;
ALTER TABLE revisions DROP CONSTRAINT revisions_content_hash_fkey;

CREATE FUNCTION mdr_content_hash_exists(doc_kind text, content_hash text) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN doc_kind = 'file'
        THEN EXISTS (SELECT 1 FROM file_blobs WHERE hash = content_hash)
        ELSE EXISTS (SELECT 1 FROM blobs WHERE hash = content_hash)
    END
$$;

CREATE FUNCTION mdr_documents_content_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT mdr_content_hash_exists(NEW.kind, NEW.content_hash) THEN
        RAISE EXCEPTION 'documents.content_hash % has no % blob', NEW.content_hash, NEW.kind
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER documents_content_check
    BEFORE INSERT OR UPDATE OF content_hash, kind ON documents
    FOR EACH ROW EXECUTE FUNCTION mdr_documents_content_check();

CREATE FUNCTION mdr_revisions_content_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    doc_kind text;
BEGIN
    SELECT kind INTO doc_kind FROM documents WHERE id = NEW.document_id;
    IF NOT mdr_content_hash_exists(coalesce(doc_kind, 'text'), NEW.content_hash) THEN
        RAISE EXCEPTION 'revisions.content_hash % has no % blob', NEW.content_hash, doc_kind
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER revisions_content_check
    BEFORE INSERT OR UPDATE OF content_hash ON revisions
    FOR EACH ROW EXECUTE FUNCTION mdr_revisions_content_check();
