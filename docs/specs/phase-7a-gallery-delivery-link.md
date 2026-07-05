# Phase 7a — Gallery delivery-link (provider-agnostic MVP)

Status: 🔵 spec (design only — no implementation in this doc)
Depends on: nothing new. Buildable now. No third-party API, no new secret, no provider account.
Ledger: `docs/autonomous-build-loop.md` row 7a. Roadmap: `docs/roadmap.md` Phase 7.

## 1. Summary and scope

Phase 7's decision (roadmap, 2026-07-04) is **integrate-first**: the studio delivers
final images through an existing provider (Pixieset / Pic-Time / Cloudinary), not an
in-house gallery. 7a is the thinnest useful slice of that decision — the piece that
needs **zero provider credentials**:

> The studio creates the gallery in whatever tool it already uses, copies the public
> delivery URL, and pastes it into Studio against the project. Studio stores it, surfaces
> it to the client in the portal, and exposes it (read-only) to agents/MCP so the
> assistant can reference or hand off the link.

Everything provider-specific (OAuth, API keys, proofing/favorite sync, auto-import of
image counts, print-store status) is **7b** and is explicitly **out of scope** here — it
needs Tyler's provider choice + credentials and is gated in the ledger as `🅣`.

### In scope (7a)
1. A `project_galleries` record (data model + migration + inline-ensure).
2. URL validation/normalization + safe rendering (no `javascript:`, no HTML injection).
3. A **"Your Gallery"** portal section that shows only `delivered` galleries, scoped to
   the authenticated project.
4. Read-only `galleries` array on `studio_get_project_context` (agent/MCP + REST), plus an
   admin create/update/delete surface with activity logging; optionally an agent
   *draft/attach-only* tool.
5. Flag gate `PORTAL_GALLERY_ENABLED` (OFF by default) on the **client-facing** surface so
   deploy is dark and Tyler can pre-populate galleries before flipping it on.

### Out of scope (7a) — do not build here
- **Provider API integration** (Pixieset/Pic-Time/Cloudinary OAuth, API keys, webhooks) → 7b.
- **Proofing / favoriting / selection sync**, gallery image counts, cover images → 7b.
- **Print-store / e-commerce status** → 7b.
- **Owned-asset (R2) galleries.** Phase 6 R2 private object access is live-but-dark and is
  available for *owned* assets (contract/invoice PDFs today; owned gallery files later),
  but 7a links to **external** provider URLs only — no upload, no R2 object, no signed-URL
  minting. See §7.
- **Client-facing send** (email/SMS of the gallery link). Consistent with the existing
  "agents draft, Tyler sends" guard — 7a stores/surfaces; a human sends. No send tool.

## 2. Active-Learning Log pre-emption (read first)

These are the classes the Fable gate has caught repeatedly (`docs/autonomous-build-loop.md`).
Each is addressed by design here so the builder does not re-discover them:

- **Off-by-default flag.** `PORTAL_GALLERY_ENABLED` gates the **portal (client-facing)**
  surface only; unset ⇒ the "Your Gallery" section renders nothing. Admin/agent read + admin
  write are always available so Tyler can populate dark. Rollback = unset the flag (§6).
- **Migration ordering.** The client-portal read is **flag-gated**, so the feature migrates
  **dark** and the migration may be applied anytime relative to the Worker deploy — but do
  NOT ship an *always-on* unflagged query against `project_galleries` before the table
  exists. The one always-on reader is `studio_get_project_context` (§5); its gallery query
  MUST be resilient to a missing table (the inline-ensure in `client.ts` creates it locally;
  prod applies the migration first). Recommended order regardless: apply 0086 to prod → verify
  table + sanity → deploy Worker. Flag-gated portal read can flip later.
- **Prod D1 migrations.** Additive only. Apply via idempotent `CREATE TABLE IF NOT EXISTS`
  direct `d1 execute --file`; do NOT `migrations apply --remote` (tracker is out of sync).
- **Build gate.** Verify `npm run build` **exit code**, not a phrase. Avoid
  `env: {...} = process.env` default-param weak-type; read `process.env.PORTAL_GALLERY_ENABLED`
  in the function body (mirror `magicLinkEnabled()` in `src/lib/portal.ts`).
- **Untrusted-ish input / injection.** The pasted URL is admin-entered (semi-trusted) but
  **rendered to clients**. Treat it as hostile at render: https-only, reject `javascript:`/
  `data:`/`vbscript:`, length-cap every stored field, and never interpolate it into HTML
  attributes unescaped (React escapes by default — keep it that way; no `dangerouslySetInnerHTML`).
- **Agent authority.** The shared `STUDIO_AGENT_API_TOKEN` permits unblocked canonical
  mutations. If an agent write tool is added (§5, optional), it is **draft/attach-only**:
  it may create a `draft` gallery, never one with `status="delivered"`, and never sends the
  client anything. A guard test asserts an agent cannot mint a client-visible gallery.
- **Proxy composition.** No new public/machine endpoint is introduced. The portal
  (`/portal`, `/p/*`) and the agent API (`/api/agent/*`, `/api/mcp`) are **already** correctly
  composed through the Pages proxy + origin guard + agent-token guard. 7a adds a section to an
  existing portal page and a field to an existing context payload — no new proxy classifier
  predicate, no new `adminProofRequired` exemption. Do not add a new route that needs proxy
  classification.
- **Secrets fail closed.** None new (§6). Nothing to fail closed.

## 3. Data model — new table `project_galleries`

**Decision: a new table, not columns on `projects`.** A project legitimately has **more than
one** gallery — a wedding project commonly delivers an *engagement* gallery months before the
*wedding* gallery, and sometimes a *sneak-peek* gallery before the full set. Columns on
`projects` (`gallery_url`, `gallery_status`, …) cannot represent N galleries, would force a
destructive overwrite when the second gallery arrives, and could not carry per-gallery status
/ delivered_at / passcode. A child table keyed by `project_id` is the correct shape and matches
existing one-to-many children (`project_events`, `project_locations`, `asset_objects`).

### 3.1 Drizzle schema (add to `src/db/schema.ts`, near `assetObjects` / `portalAccessTokens`)

```ts
export const projectGalleries = sqliteTable("project_galleries", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  // Free-text provider label for display/attribution ("Pixieset", "Pic-Time",
  // "Cloudinary", "Other"). NOT an enum — 7a is provider-agnostic; do not couple
  // storage to a fixed provider set. Length-capped in the lib, not the schema.
  provider: text("provider"),
  title: text("title").notNull(),          // e.g. "Engagement gallery", "Wedding gallery"
  url: text("url").notNull(),              // validated https delivery URL (see §4)
  // draft  → admin-only, not shown to clients
  // delivered → visible in the portal when the flag is ON
  // archived → hidden from the portal, retained for the record
  status: text("status").notNull().default("draft"),
  passcode: text("passcode"),             // optional; provider-side gallery passcode, display-only
  deliveredAt: text("delivered_at"),      // set when status first becomes "delivered"
  expiresAt: text("expires_at"),          // optional provider expiry, display-only ("available until")
  createdBy: text("created_by").notNull().default("admin"), // "admin" | "agent"
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export type ProjectGallery = typeof projectGalleries.$inferSelect;
```

Notes:
- `status` and `createdBy` are stored as plain TEXT with a default (matches how `projects.stage`,
  `portalAccessTokens.kind` are modeled). Domain validation is enforced in the lib. A
  BEFORE-INSERT/UPDATE canon trigger (mirroring the `portal_access_tokens` detail-text guards in
  migration 0084) is **optional hardening** — recommend deferring it to keep 7a small unless the
  Fable review asks for a DB-level domain guard. If added, guard: `status IN ('draft','delivered','archived')`,
  `created_by IN ('admin','agent')`, and trimmed-non-empty `title`/`url`.
- `passcode` is stored plaintext because it is a *display convenience* the studio types in from
  the provider's own gallery settings — it is not a Studio auth secret and grants no Studio access.
  It is only shown to an already-authenticated portal client. (Note this trade-off in the migration
  comment; do not treat it as a credential.)

### 3.2 Migration `migrations/0086_project_galleries.sql`

Next number after 0085 (`0085_inbound_inquiries.sql`). Additive, backward-compatible,
idempotent — no change to any existing table.

```sql
-- Phase 7a: provider-agnostic gallery delivery links.
--
-- Additive, backward-compatible. A project may have >1 gallery (engagement +
-- wedding + sneak-peek), so this is a child table, not columns on projects.
-- 7a stores an EXTERNAL provider delivery URL only — no owned assets, no R2
-- object, no provider API. status defaults to 'draft' so a freshly-attached
-- gallery is admin-only until explicitly marked 'delivered'.
CREATE TABLE IF NOT EXISTS project_galleries (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  passcode TEXT,
  delivered_at TEXT,
  expires_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_galleries_project ON project_galleries(project_id);
CREATE INDEX IF NOT EXISTS idx_project_galleries_project_status
  ON project_galleries(project_id, status);
```

### 3.3 Inline-ensure in `src/db/client.ts`

Add a block in `migrate()` after the 0085 inbound-inquiries block (~line 630), matching the
established idempotent pattern (the `inbound_inquiries` block is the closest model — a plain
`CREATE TABLE IF NOT EXISTS` + indexes, not `addColumnIfMissing`, because this is a whole new
table):

```ts
const projectGalleriesMigrationPath = path.join(process.cwd(), "migrations", "0086_project_galleries.sql");
if (fs.existsSync(projectGalleriesMigrationPath)) {
  database.exec(fs.readFileSync(projectGalleriesMigrationPath, "utf8"));
}
// Phase 7a: defensive idempotent create so local dev (better-sqlite3) and any
// partially-migrated prod D1 converge without a blanket `migrations apply`.
database.exec(`
  CREATE TABLE IF NOT EXISTS project_galleries (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider TEXT,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    passcode TEXT,
    delivered_at TEXT,
    expires_at TEXT,
    created_by TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_project_galleries_project ON project_galleries(project_id);
  CREATE INDEX IF NOT EXISTS idx_project_galleries_project_status ON project_galleries(project_id, status);
`);
```

## 4. URL validation, normalization, and safe rendering

New helper module `src/lib/gallery.ts` owns all gallery logic (validation, canonical CRUD,
context shaping) so validation cannot be bypassed by a second caller. This mirrors how
`src/lib/portal.ts` centralizes portal-token logic.

### 4.1 Validation / normalization — `normalizeGalleryUrl(raw): string`

Rules (reject ⇒ throw a user-facing `Error`, caught by the admin action and re-shown on the form):

1. Trim; cap length at **2048** chars (reject longer — a pasted URL over 2KB is abuse/garbage).
2. Parse with the WHATWG `URL` constructor. Reject on parse failure.
3. **Protocol allowlist: `https:` only.** Reject `http:`, `javascript:`, `data:`, `vbscript:`,
   `file:`, `blob:`, and everything else. This single check is the primary XSS defense — a
   `javascript:` URL can never be stored, so it can never be rendered into an `href`.
4. Require a non-empty host with a dot (reject `https://localhost`, bare hostnames, IP-literal
   optional-reject). Reject credentials in the URL (`url.username`/`url.password` non-empty).
5. Return the normalized `url.toString()` (canonical form; strips nothing sensitive, just
   normalizes casing/encoding).

```ts
export function normalizeGalleryUrl(raw: string): string; // throws on invalid
```

### 4.2 Optional provider-host allowlist (note — do NOT hard-require)

Maintain a soft allowlist of known delivery hosts for a **non-blocking UX hint** and to set the
`provider` label default:

```ts
const KNOWN_GALLERY_HOSTS: Record<string, string> = {
  "pixieset.com": "Pixieset",
  "pic-time.com": "Pic-Time",
  "cloudinary.com": "Cloudinary",
  // suffix match, e.g. "*.pixieset.com"
};
export function inferProviderLabel(url: string): string | null;
```

Because 7a is provider-agnostic and studios use custom domains (`gallery.brand.com`), the
allowlist **must not reject** an unknown host — an unrecognized host is still stored; the UI may
show a soft "Unrecognized gallery host — double-check the link" note. Hard-blocking is a 7b
policy decision once Tyler picks a provider.

### 4.3 Safe rendering

- Portal (`src/app/portal/page.tsx`) and admin render the URL only inside JSX `{gallery.url}` and
  `href={gallery.url}` — **React escapes both by default**. No `dangerouslySetInnerHTML`, no
  string-built HTML.
- External links use `target="_blank" rel="noopener noreferrer"` (matches existing portal
  external links, e.g. proposal/stripe links).
- Since only `https:` URLs can be persisted (§4.1 step 3), the rendered `href` can never carry a
  script scheme even if a row were somehow written directly. Defense-in-depth: the portal context
  shaper (`getPortalProjectContext`) re-checks `url.startsWith("https://")` before including a
  gallery and drops any row that fails (a belt-and-suspenders guard against a hand-edited D1 row).

## 5. Surfaces

### 5.1 Client portal — "Your Gallery" section (flag-gated)

**Loader:** extend `getPortalProjectContext(projectId, clientId)` in `src/lib/portal.ts`. It is
already the single scoped loader reached via `requirePortalProject()` (cookie → token → project,
`kind="session"` only, no IDOR). Add a query, gated so it does zero work when the flag is off:

```ts
// inside getPortalProjectContext, added to the existing Promise.all batch or after it
const galleries = galleryPortalEnabled()
  ? await db.query.projectGalleries.findMany({
      where: and(
        eq(projectGalleries.projectId, projectId),
        eq(projectGalleries.status, "delivered"), // delivered-only for clients
      ),
      orderBy: desc(projectGalleries.deliveredAt),
    })
  : [];
```

- `galleryPortalEnabled()` = `process.env.PORTAL_GALLERY_ENABLED === "1"` (body read, mirroring
  `magicLinkEnabled()`). Flag OFF ⇒ empty array ⇒ section renders nothing (dark deploy).
- **Delivered-only:** `draft` and `archived` galleries are never returned to the portal.
- **Scoping:** the query is filtered by the `projectId` that `requirePortalProject` already
  resolved from the session cookie/token — same scoping as every other portal child. No
  cross-project read is possible because `projectId` is not client-supplied.
- Map to a minimal client-safe shape (drop `createdBy`, keep `id`, `title`, `provider`, `url`,
  `passcode`, `deliveredAt`, `expiresAt`), re-validating `https://` per §4.3.

Return it on the context object as `galleries: [...]`.

**View:** add a `PortalGallerySection` to `PortalProjectView` in `src/app/portal/page.tsx`,
styled like the existing sections (border/`--surface` card, a lucide icon such as `Images` or
`Camera`). Render nothing when `data.galleries.length === 0` (so an off-flag or gallery-less
project shows no empty card). Each row: title, provider label, optional "available until
{expiresAt}", optional passcode line, and a primary button:

```tsx
<a href={gallery.url} target="_blank" rel="noopener noreferrer" className="...">
  <ExternalLink className="h-4 w-4" /> View gallery
</a>
```

### 5.2 Agent/MCP read — `studio_get_project_context`

Extend the read-only context so an agent can reference/hand off the link. In
`projectContextResult()` (`src/lib/studio-mcp.ts`, ~line 1550), add a query and include it on the
returned object as `galleries`. **This reader is always-on (not flag-gated)** — the agent surface
is a trusted backoffice tool and needs to see drafts too — so it must tolerate the table being
absent in a not-yet-migrated environment (see §2 migration-ordering; the recommended deploy order
applies 0086 before the Worker). Return **all statuses** with the status field so the agent knows
what is client-visible vs. draft:

```ts
const galleries = await db.query.projectGalleries.findMany({
  where: eq(projectGalleries.projectId, project.id),
  orderBy: [desc(projectGalleries.status), desc(projectGalleries.createdAt)],
});
// included on the return object:
galleries: galleries.map((g) => ({
  id: g.id, title: g.title, provider: g.provider, url: g.url,
  status: g.status, passcode: g.passcode,
  deliveredAt: g.deliveredAt, expiresAt: g.expiresAt, createdBy: g.createdBy,
})),
```

This automatically flows to both consumers of `getStudioProjectContext`:
- MCP `studio_get_project_context` (tool already registered at `src/lib/studio-mcp.ts:71`).
- REST `GET /api/agent/projects/[id]/context` (`src/app/api/agent/projects/[id]/context/route.ts`).

Update the `studio_get_project_context` description in `docs/studio-agent-access.md` (the long
"Get Project Context" paragraph) to mention gallery delivery links are now included.

### 5.3 Admin create/update/delete (canonical mutation + activity logging)

Follow the existing `updateProjectFromForm` / `updateProjectAction` pattern in `src/lib/crm.ts`
(form action → `redirect`), with logic in `src/lib/gallery.ts`:

```ts
// src/lib/gallery.ts — canonical mutations (called by server actions AND the agent tool)
export async function createProjectGallery(input: {
  projectId: string; title: string; url: string; provider?: string | null;
  status?: "draft" | "delivered" | "archived"; passcode?: string | null;
  expiresAt?: string | null; createdBy?: "admin" | "agent";
  actorType?: "admin" | "agent"; actorName?: string | null;
}): Promise<ProjectGallery>;

export async function updateProjectGallery(input: {
  galleryId: string; projectId: string; /* ...same mutable fields... */
}): Promise<ProjectGallery>;

export async function deleteProjectGallery(input: {
  galleryId: string; projectId: string; actorType?: "admin" | "agent"; actorName?: string | null;
}): Promise<void>;
```

Behavior:
- Validate `projectId` exists; validate `url` via `normalizeGalleryUrl`; cap `title` (200),
  `provider` (80), `passcode` (200); validate `status` against the domain set.
- **`deliveredAt` transition:** set `deliveredAt = now` the first time `status` becomes
  `"delivered"` and it is currently null; leave it stable afterward (do not bump on later edits).
- **Activity logging** via `logActivity` (`src/lib/activity.ts`) — new actions:
  `gallery.created`, `gallery.updated`, `gallery.deleted`, with metadata
  `{ galleryId, status, provider }`. Add human labels to `formatActivityAction`
  (`src/lib/format.ts`) so `/activity` and `studio_list_activity` render them.
- `safeRevalidatePath` the project + portal-relevant paths as `updateProjectFromForm` does.

**Server actions + UI:** add `createProjectGalleryAction` / `updateProjectGalleryAction` /
`deleteProjectGalleryAction` (`"use server"`, `redirect` back to the project) in `src/lib/crm.ts`
or a co-located `src/lib/gallery-actions.ts`. Surface a "Galleries" panel on the project detail
page (`src/app/projects/[id]/page.tsx`) — a small list + an add/edit form component
(`src/components/ProjectGalleryForm.tsx`) modeled on `ProjectEditForm.tsx` (same `inputClass`,
hidden `projectId`, provider text input, status `<select>` of draft/delivered/archived, url,
optional passcode/expiry). Admin sees **all** statuses; the form is where Tyler flips a gallery
to `delivered`.

### 5.4 Optional agent tool — `studio_attach_gallery_link` (draft/attach-only)

Optional, low priority. If added, it is **attach-only and cannot deliver**:
- Registered like other write tools in `src/lib/studio-mcp.ts`; also a REST route
  `POST /api/agent/projects/[id]/galleries` under the existing agent guards
  (`guardDirectWorkerApiRequest` + `guardAgentApiRequest`, matching the context route).
- Forces `status="draft"` and `createdBy="agent"` **regardless of input** — an agent can stage a
  link for Tyler to review/deliver, never publish one to the client, never send anything.
- Logs `gallery.created` with `actorType:"agent"`, `actorName:"The Reeses Studio Agent"`.
- **Guard test required** (Active-Learning Log agent-authority rule): a hostile agent body with
  `status:"delivered"` must persist a `draft` row (zero client-visible rows created).

If the review prefers minimal surface, ship 7a **without** the write tool — the agent read
(§5.2) already satisfies "an agent can reference/send the link"; Tyler attaches via admin (§5.3).

## 6. Flag, config, secrets, rollout

- **Flag:** `PORTAL_GALLERY_ENABLED` (string `"1"` to enable), **unset/OFF by default**. Gates the
  **client-facing portal surface only** (§5.1). Admin CRUD (§5.3) and agent read (§5.2) are always
  on so Tyler can populate galleries dark, verify them in agent context, then flip the flag to make
  them client-visible. Register the flag in whatever env-var doc/`wrangler.toml` vars list the
  existing `PORTAL_MAGIC_LINK_ENABLED` flag lives in, defaulting empty.
- **Secrets:** **none new.** 7a stores an admin-pasted public URL — no provider API key, no signing
  secret. (7b will introduce a provider API credential; note it as a *future* row in the
  `docs/studio-agent-access.md` credential inventory, not added now.) R2 signing secret is **not**
  used (§7).
- **Migration:** additive `0086` + inline-ensure (§3). Backward-compatible; existing flows never
  touch `project_galleries`.
- **Rollback:** **flag-only** for the client surface (unset `PORTAL_GALLERY_ENABLED`). The table and
  admin/agent read can remain — they are inert without client exposure. Full code rollback = Worker
  version rollback per the standard deploy rails; the additive table is harmless if left in place.
- **Deploy order:** apply 0086 to prod D1 (`d1 execute --file`) → verify table + a sanity
  `SELECT count(*)` → deploy Worker + Pages-proxy → health-check. Flag stays OFF at deploy; Tyler
  flips after populating + observing (enablement flip is **not** autonomous — guardrail 2).

## 7. R2 note (Phase 6) — available, not required here

Phase 6 shipped R2 private object access (live-but-dark; signed URLs, `asset_objects` table). It is
available for **owned** gallery assets in a later slice (upload originals to R2, mint signed
delivery URLs). **7a deliberately does not use it** — 7a links to *external provider* galleries, so
there is no owned object to store, no `asset_objects` row, and no `R2_URL_SIGNING_SECRET` use. If a
future "owned R2 gallery" slice lands, `project_galleries` can gain an optional
`asset_bundle_id`/`kind` column (external-link vs owned-R2) without reshaping 7a — the table already
models N galleries per project with a provider label.

## 8. Test plan (per file)

- **`src/lib/gallery.test.ts` — validation/XSS (highest priority):**
  - `normalizeGalleryUrl` accepts a normal `https://…pixieset.com/…` URL and returns canonical form.
  - **Rejects** `javascript:alert(1)`, `data:text/html,…`, `vbscript:…`, `http://…` (non-TLS),
    `file://…`, a `>2048`-char string, credentials-in-URL, and an unparseable string.
  - `inferProviderLabel` maps known hosts and returns `null` (does **not** throw/reject) for an
    unknown/custom host.
  - `createProjectGallery` sets `deliveredAt` when status starts as `delivered`, and leaves it
    stable across a later `updateProjectGallery` edit; leaves it null for `draft`.
  - Field length caps enforced (title/provider/passcode).
- **`src/lib/portal.test.ts` (or the existing portal test) — scoping + delivered-only + flag:**
  - With flag ON: a `delivered` gallery on project A appears in A's context; a `draft` and an
    `archived` gallery do **not** appear.
  - **No cross-project leak:** a `delivered` gallery on project B never appears in project A's
    `getPortalProjectContext(A, …)`.
  - With flag OFF (`PORTAL_GALLERY_ENABLED` unset): `galleries` is empty even when a delivered
    gallery exists (dark).
  - Portal shaper drops a row whose `url` does not start with `https://` (defense-in-depth §4.3).
- **`src/lib/studio-mcp.test.ts` — agent read:** `studio_get_project_context` includes `galleries`
  with all statuses + the `status` field; ordering is stable; excludes nothing client-safe but does
  surface `draft` to the agent.
- **Admin mutation test (crm/gallery-actions):** create → update (flip to delivered, `deliveredAt`
  set) → delete round-trip; each logs the matching `gallery.*` activity with correct `actorType`.
- **Agent-authority guard test (only if §5.4 is built):** an agent `POST …/galleries` body with
  `status:"delivered"` persists a `draft`, `createdBy:"agent"` row and creates **zero** client-visible
  galleries; a delivered gallery is never mintable by the agent token.
- **Build gate:** `npm run lint` clean; `npm run build` **exit code 0** (not just "Compiled
  successfully"); `npm test` green.

## 9. Ordered task breakdown (effort / risk)

| # | Task | Files | Effort | Risk |
| --- | --- | --- | --- | --- |
| 1 | Schema + migration 0086 + inline-ensure | `src/db/schema.ts`, `migrations/0086_project_galleries.sql`, `src/db/client.ts` | S | Low (additive) |
| 2 | `gallery.ts`: `normalizeGalleryUrl`, `inferProviderLabel`, canonical create/update/delete + activity | `src/lib/gallery.ts`, `src/lib/format.ts` | M | **Med — URL safety/XSS is the core risk; test first** |
| 3 | Agent read: add `galleries` to `projectContextResult` + doc update | `src/lib/studio-mcp.ts`, `docs/studio-agent-access.md` | S | Low (read-only, must tolerate missing table) |
| 4 | Admin UI: project galleries panel + form + server actions | `src/app/projects/[id]/page.tsx`, `src/components/ProjectGalleryForm.tsx`, `src/lib/crm.ts` (or `gallery-actions.ts`) | M | Low |
| 5 | Portal surface: flag-gated loader + "Your Gallery" section | `src/lib/portal.ts`, `src/app/portal/page.tsx` | M | **Med — flag-off dark + delivered-only + scoping** |
| 6 | Tests (all §8) | `src/lib/gallery.test.ts`, portal/mcp tests | M | Low |
| 7 | (Optional) agent attach-only tool + guard test | `src/lib/studio-mcp.ts`, `src/app/api/agent/projects/[id]/galleries/route.ts` | M | **Med — agent authority; skip if trimming scope** |
| 8 | Flag registration + roadmap/ledger update | env/vars doc, `docs/roadmap.md`, `docs/autonomous-build-loop.md` | S | Low |

Recommended MVP cut if trimming: tasks 1–6 (+8). Task 7 is optional — the agent read already
covers "reference/send the link," and admin attach covers population.
