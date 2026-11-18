-- Stage 2 (ADR-007, ADR-008). No version history: a document keeps only its current content. `head_revision_id`
-- stays as the compare-and-swap version token; the `revisions` table and every blob that only an
-- old revision referenced are removed. Handlers delete a replaced blob once nothing references it
-- (`drop_blob_if_unreferenced`).

DROP TRIGGER revisions_content_check ON revisions;
DROP FUNCTION mdr_revisions_content_check();
DROP TABLE revisions;


-- Text documents of any kind (Markdown, plain text, code, logs) keep their file encoding so clients
-- write the same bytes back; NULL means UTF-8. The stored content is always UTF-8.
ALTER TABLE documents ADD COLUMN encoding text NULL;

-- Binary documents become editable. The bytes they were imported with stay as the "original of
-- import" (`original_hash`, in `file_blobs`) while `content_hash` follows every edit.
ALTER TABLE documents ADD COLUMN original_hash text NULL;
UPDATE documents SET original_hash = content_hash WHERE kind = 'file';
ALTER TABLE documents
    ADD CONSTRAINT documents_original_kind_check CHECK (original_hash IS NULL OR kind = 'file');

CREATE OR REPLACE FUNCTION mdr_documents_content_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT mdr_content_hash_exists(NEW.kind, NEW.content_hash) THEN
        RAISE EXCEPTION 'documents.content_hash % has no % blob', NEW.content_hash, NEW.kind
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.original_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM file_blobs WHERE hash = NEW.original_hash) THEN
        RAISE EXCEPTION 'documents.original_hash % has no blob', NEW.original_hash
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER documents_content_check ON documents;
CREATE TRIGGER documents_content_check
    BEFORE INSERT OR UPDATE OF content_hash, kind, original_hash ON documents
    FOR EACH ROW EXECUTE FUNCTION mdr_documents_content_check();

-- Blobs that only an old revision referenced.
DELETE FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.content_hash = b.hash);
DELETE FROM file_blobs f
    WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.content_hash = f.hash OR d.original_hash = f.hash);
