# Architecture

## Runtime

- Next.js App Router with TypeScript.
- Local development uses SQLite at `data/local.db`.
- Production target is Cloudflare Workers/Pages with D1.
- Drizzle ORM defines the SQLite/D1-compatible schema.
- R2 is reserved for generated PDFs, signed contracts, and attachments.

## Data Ownership

The canonical active repo is `/Volumes/reeseai-memory/04_Code/reese-photography-crm`. Daily backup rsync targets the same path (non-destructive). See [`crm-source-of-truth-sop.md`](crm-source-of-truth-sop.md).

## Storage Budget

Cloudflare free-tier usage is a hard product constraint. Keep D1 lean by storing only structured CRM records, IDs, timestamps, statuses, small JSON form answers, and audit metadata. Do not store generated PDFs, images, file attachments, raw email bodies, large exports, base64 blobs, or duplicative calendar payloads in D1.

R2 is reserved for client-facing files that must live with the product, such as signed PDFs, generated proposal PDFs, attachments, and export bundles. Prefer compact generated artifacts, predictable object keys, and explicit retention/archive rules before adding any file-heavy workflow. Operational backups belong on `/Volumes/reeseai-memory/09_Backups/backups/reese-photography-crm`, not in production R2 by default.

## Trust Boundaries

- Admin routes are intended for Tyler only.
- Client portal routes are scoped by an httpOnly cookie pair: `portal_project_id` and `portal_token_id`.
- Tokens are generated as random plaintext values, stored only as SHA-256 hashes, and shown once in the generated link.
- Every portal read validates the exact token record, project id, expiry, and revocation status.
