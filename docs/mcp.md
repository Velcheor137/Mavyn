# MCP server (`/mcp`)

The server speaks the [Model Context Protocol](https://modelcontextprotocol.io) so AI clients such as
Claude Code can browse, read and edit a Mavyn library. Transport: Streamable HTTP, stateless, JSON
responses (`apps/server/src/mcp.rs`, built on the official Rust SDK `rmcp`).

## Connecting

1. In the web app, as a server administrator: Settings → API keys → Create key. Choose the
   libraries, read-only or read-and-write access, whether deleting is allowed, and the expiry.
2. Copy the key (shown once) or the ready-made command:

```bash
claude mcp add --transport http mavyn https://notes.example/mcp --header "Authorization: Bearer mvn_…"
```

Add `--scope user` to make it available in every project. Other MCP clients that can send an
`Authorization` header (Claude Desktop through its config, IDE agents, scripts) connect the same way.
The web version of claude.ai connects custom MCP servers only through OAuth, which Mavyn does not
offer yet.

## Tools

The tools a key sees depend on its access: read-only keys get the first five, write keys also get
the editing tools, and only keys with "allow deletion" get the two delete tools.

| Tool | What it does |
|---|---|
| `list_libraries` | Libraries the key can access, with your role |
| `list_documents` | Folders and documents of a library (or one folder subtree): paths, kind, MIME, `head_revision_id` |
| `search` | Full-text search in a library (files by title) |
| `read_document` | Text of a document, paged by `offset`/`limit` characters. Files return extracted text: docx with headings, lists and tables; xlsx/ods as one Markdown table per sheet with column letters and row numbers; pdf per page |
| `download_file` | Original bytes of a file document as a base64 resource |
| `create_document` | New text document (Markdown, code, plain text) |
| `update_document` | Replace a text document's content (needs `base_revision_id`) |
| `upload_file` | New docx/xlsx/ods/pdf from base64 |
| `replace_file` | New version of a file document from base64 (needs `base_revision_id`) |
| `rename_or_move_document`, `rename_or_move_folder` | Rename and/or move |
| `create_folder` | New folder |
| `delete_document`, `delete_folder` | Delete (a folder with everything in it) |

Every write is compare-and-swap: pass the `head_revision_id` of your latest read as
`base_revision_id`; if the document changed meanwhile, the tool fails with `sync.conflict` and the
model reads it again. Changes reach the user's devices on their next sync.

## How it works and what protects it

- Each tool calls the ordinary `/api/v1` route in-process with the caller's key, so roles, key scope,
  validation, compare-and-swap and rate limits are the same as for the REST API ([api.md](api.md)).
- `/mcp` accepts only API keys: sign-in sessions and cookies are ignored, so a web page cannot drive
  it from a signed-in browser. Missing or invalid keys get `401` with `WWW-Authenticate: Bearer`.
- A request with an `Origin` header other than `PUBLIC_ORIGIN` is refused (`403`), as the MCP
  specification asks against DNS rebinding.
- Text extraction (`apps/server/src/extract.rs`) runs on a blocking thread with a 10 s timeout and
  panic isolation; zip containers are refused if they unpack to more than 100 MiB; extracted text is
  capped at 2 MiB (`extractor_truncated` in the result). Extraction is read-only: office files are
  always written back as whole files.

## Not implemented

- OAuth 2.1 authorization (needed for claude.ai custom connectors).
- MCP resources and prompts; only tools are offered.
- Partial edits of office files (cell by cell, paragraph by paragraph) over MCP.
