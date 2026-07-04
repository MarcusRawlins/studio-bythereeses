# Phase 6: Hardening + R2 private access — Design Spec

**Status:** DESIGN ONLY (no implementation in this document). Author: senior engineer. Date: 2026-07-04.
**Runtime facts this spec is grounded in:** Next.js 16 App Router on Cloudflare Workers via OpenNext (`@opennextjs/cloudflare`, worker entry `.open-next/worker.js`), Drizzle + D1 (binding `DB`, db `studio-bythereeses`), R2 bucket `studio-bythereeses` bound as `CRM_ASSETS` in `wrangler.jsonc` **but currently unused in code**. A Cloudflare Pages front door (`pages-proxy/_worker.js`) sits in front of the Worker origin (`reese-photography-crm.solitary-flower-c3ab.workers.dev`) and terminates the Google admin session, injects `x-reese-origin-secret`, and applies the final security headers. Bindings are read in-app via `getCloudflareContext().env` (see `src/db/client.ts:964-970`).

**Sources closed by this phase:** `docs/qa-production-workflows-2026-07-04.md` findings **M4** (single-layer admin authz), **L7** (proposal token in URL / Referrer-Policy), **L8** (CSP has no `script-src`), and the **Info — dead code** item (6 blocked finance `*FromAgent` bodies). Roadmap Phase 6 bullet, `docs/security-model.md` "Remaining Hardening", and `docs/route-access-audit.md` "Known Follow-Ups".

**Non-negotiables carried from repo conventions**
- Read the relevant Next 16 guide in `node_modules/next/dist/docs/` before touching CSP/nonce or middleware behavior (per `AGENTS.md`). Next 16 here is a breaking version; do not assume training-data APIs.
- No Phase 6 branch merges to `main` or deploys without explicit Tyler approval; AI review on Fable first (roadmap §Delivery status).
- The origin guard must stay in `src/middleware.ts`; do **not** reintroduce `src/proxy.ts` (OpenNext cannot deploy Node middleware — `ops-stabilization-checklist.md:19,35`).
- All secrets are Cloudflare Worker/Pages secrets, never committed; keychain services already in use: `reese-studio-agent-api-token`, `reese-crm-cloudflare-api-token`.

---

## Section 1 — R2 private object access (prerequisite for Phase 7)

### Goal
Private-by-default storage + serving for owned assets: generated contract PDFs, invoice PDFs, and any future gallery-adjacent owned files. R2 buckets have **no public access unless a public `r2.dev`/custom domain is attached** — the design's first rule is: **never attach a public domain to `studio-bythereeses`.** Every read flows through the Worker with an authenticated or signed request.

### Data model (new D1 table + migration)
New Drizzle table `asset_objects` (migration file: next number in `src/db/` migration sequence, e.g. `0083_asset_objects` — confirm the current max in `src/db/`):

```
asset_objects
  id            text primary key            -- nanoid/uuid
  key           text not null unique         -- full R2 object key (see scheme)
  kind          text not null                -- 'contract_pdf' | 'invoice_pdf' | 'project_source_file' | 'gallery_file'
  project_id    text not null references projects(id)
  proposal_id   text null references proposals(id)
  invoice_id    text null references invoices(id)
  content_type  text not null
  size_bytes    integer not null
  sha256        text not null
  created_at    text not null
  created_by    text not null                -- 'admin' | 'agent' | 'system'
  deleted_at    text null
```
Index: `(project_id, kind)`, `(proposal_id)`.

### Key / prefix scheme
Deterministic, project-scoped, no user-controlled path segments (prevents traversal / cross-project reads):
```
contracts/{projectId}/{proposalId}/{assetId}.pdf
invoices/{projectId}/{invoiceId}/{assetId}.pdf
sources/{projectId}/{sourceId}/{assetId}-{safeFilename}
galleries/{projectId}/{assetId}/{safeFilename}      # reserved for Phase 7 owned-asset needs
```
`{safeFilename}` is slugified server-side; the canonical identity is always `{assetId}`.

### New library: `src/lib/assets.ts`
```ts
function assetsBucket(): R2Bucket            // (getCloudflareContext().env as { CRM_ASSETS?: R2Bucket }).CRM_ASSETS, throws if unbound
async function putAsset(input: {
  kind: AssetKind; projectId: string; proposalId?: string | null; invoiceId?: string | null;
  body: ArrayBuffer | ReadableStream | Uint8Array; contentType: string; filename?: string;
  createdBy: 'admin' | 'agent' | 'system';
}): Promise<{ assetId: string; key: string; sha256: string; sizeBytes: number }>
async function getAssetObject(key: string): Promise<R2ObjectBody | null>   // env.CRM_ASSETS.get(key)
async function deleteAsset(assetId: string): Promise<void>                  // soft-delete row + env.CRM_ASSETS.delete(key)
async function getAssetMeta(assetId: string): Promise<AssetRow | null>
```
`putAsset` computes the key from the scheme, writes to R2 (`.put(key, body, { httpMetadata: { contentType } })`), inserts the `asset_objects` row, and logs an `activity_logs` action (`asset.created`) mirroring existing agent-write logging conventions.

### Serving — two authenticated paths

**(a) Primary: authenticated Worker proxy route** — `src/app/api/assets/[...key]/route.ts` (GET only).
Serves the object after verifying **one** of:
- a valid admin proxy proof (Section 2) → full read; or
- a valid **signed asset URL** (below); or
- a portal/proposal session/token whose scope covers the object's `project_id`/`proposal_id` (see mapping).
Streams `R2ObjectBody.body` with `content-type` from stored metadata, `cache-control: private, no-store`, and `content-disposition: inline` (or `attachment` for downloads).

**(b) Signed, time-limited URL** — for links embedded in Resend emails and inside generated PDFs, where no live session exists.
```ts
// src/lib/assets.ts
function signAssetUrl(assetId: string, opts: {
  ttlSeconds: number;               // default 900 (15 min); contracts in email may use 7 days
  scope: 'admin' | 'portal' | 'proposal';
  scopeRef?: string;                // projectId or proposalId the caller was already authorized for
}): string   // -> `/api/assets/{key}?exp={unix}&sc={scope}&ref={scopeRef}&sig={base64url-hmac}`
function verifyAssetUrl(url: URL): { ok: boolean; assetId?: string }
```
HMAC-SHA256 over `key + "\n" + exp + "\n" + scope + "\n" + scopeRef` with new secret **`R2_URL_SIGNING_SECRET`**. Constant-time compare (`node:crypto timingSafeEqual`, mirror `src/lib/agent-api.ts:6-11`). Reuse the existing hashing idiom from `src/lib/portal.ts:31-32`.

### Token/scope → object access mapping
The existing token model already scopes credentials to project/proposal/client (`portalAccessTokens`, `proposalAccessTokens`; hashing in `src/lib/portal.ts` and `src/lib/sales.ts:77`). Mapping rules enforced in the assets route:
- **Portal token** (scoped to `projectId`, optional `clientId`): may read `kind in ('contract_pdf','invoice_pdf','gallery_file')` where `asset_objects.project_id === token.projectId`.
- **Proposal token** (scoped to `proposalId`+`projectId`): may read the `contract_pdf` whose `asset_objects.proposal_id === token.proposalId` only.
- **Admin**: any object (proof-verified).
- No token/scope match → `404` (never `403` — matches the repo's no-info-leak posture, cf. `route-access-audit.md` proposal 404 behavior).

### Config / secrets / env keys
- `wrangler.jsonc`: `CRM_ASSETS` binding already present — **no change needed**; confirm no public domain is attached in the Cloudflare dashboard (checklist item, not code).
- New secret: `R2_URL_SIGNING_SECRET` (Worker runtime + `.env.local` for dev; fail-closed in production if unset, mirroring `L5` pattern already landed for `schedulerLinkSecret`).
- `src/lib/origin-guard.ts`: add `/api/assets/` to `PUBLIC_API_PREFIXES` (signature/token is the credential, not the origin secret) **only** for the GET route; the route itself must reject unsigned/unauthenticated requests.
- `pages-proxy/_worker.js`: add `pathname.startsWith("/api/assets/")` to `isStudioPublicPath` (and, if client-facing links are ever served on the schedule host, `isSchedulePublicPath`). Rate-limit under a new `tokenAccess`-like kind in `rateLimitKind`.
- Generate `cloudflare-env.d.ts` types once R2 is used: `npm run cf:typegen` (adds `CRM_ASSETS: R2Bucket`, `DB: D1Database`).

### Files touched
`src/lib/assets.ts` (new), `src/app/api/assets/[...key]/route.ts` (new), `src/db/schema.ts` + new migration + `src/db/client.ts` (ensure migration runs), `src/lib/origin-guard.ts`, `pages-proxy/_worker.js`. Wiring into PDF generation is Section-agnostic here — this phase lands storage/serving primitives; contract/invoice PDF **generation** is out of scope unless already present (grep found no PDF generator today — treat generation as a Phase 7 consumer).

### Test plan
- `src/lib/assets.test.ts` (new): key-scheme determinism + traversal rejection; `signAssetUrl`/`verifyAssetUrl` round-trip, expiry, tamper (flip a byte), wrong-secret; scope-mapping matrix (portal vs proposal vs admin). R2 binding mocked via a fake `R2Bucket` object injected through a `getCloudflareContext` stub (same seam already used in db tests).
- Extend `src/lib/portal-context.test.ts` / `src/lib/proposal-link-canon.test.ts` to assert a portal token cannot mint a valid asset URL for a foreign `projectId`.
- Add an assets-route unit test (`src/app/api/assets/route.test.ts` style, run by `scripts/run-tests.mjs`): 404 on unsigned, 200 on valid signed, 404 on expired.

### Rollout / rollback
- Ship storage + serving dark: nothing writes to R2 until a consumer calls `putAsset`. Deploy migration first (`npm run db:migrate` against prod per `studio-agent-access.md` live-integration checklist), then Worker, then pages-proxy.
- Rollback: revert Worker + proxy. The `asset_objects` table and any written objects are additive and safe to leave; no destructive rollback needed. Objects in R2 are orphaned-but-private if the route is removed.

---

## Section 2 — M4: in-app admin authz via signed proxy header (defense-in-depth)

### Problem (from M4)
Admin authorization is **single-layer**: only the Pages proxy Google session gates admin pages/APIs; `guardDirectWorkerApiRequest`/`guardDirectWorkerPageRequest` only block raw `*.workers.dev` and are a no-op on the custom domain. If the proxy is bypassed or `ORIGIN_PROXY_SECRET` is unset, the app has no independent admin check.

### Design: HMAC proof header set by proxy, verified in app
The proxy already validates the Google session (`verifyAdminSession`, `pages-proxy/_worker.js:68-85`). After that passes for a Studio admin request, the proxy sets a signed proof header the app independently verifies.

**Header:** `x-reese-admin-proof: v1.{tsSeconds}.{sigBase64url}`
where `sig = HMAC_SHA256(ADMIN_PROOF_SECRET, `${method}\n${pathname}\n${tsSeconds}`)`.
Path is bound (prevents replay against a different route); timestamp bounds replay window.

**New shared secret:** `ADMIN_PROOF_SECRET` — set as **both** a Pages-proxy env var and a Worker runtime secret (single value in two places, like the existing `ORIGIN_PROXY_SECRET` split).

**Proxy side** (`pages-proxy/_worker.js`): reuse existing `hmac(secret, value)` helper (line 41). In the Studio-host branch, after `verifyAdminSession(request, env)` returns true and the path is an admin surface (i.e. not `isStudioPublicPath`), compute the proof and set it on the forwarded `headers` alongside `x-reese-origin-secret` (near line 452). It must be set on the request to the origin, not the response. Also strip any inbound `x-reese-admin-proof` from the client first (defense against spoofing), exactly as origin-secret is trusted only from the proxy.

**App side — new helper** `src/lib/admin-proxy-auth.ts`:
```ts
export const ADMIN_PROOF_HEADER = "x-reese-admin-proof";
export async function verifyAdminProxyProof(request: Request, opts?: {
  now?: number; maxSkewSeconds?: number;   // default 300
}): Promise<boolean>;                        // false unless: secret configured, header present, ts within skew, HMAC(method,path,ts) matches (timingSafeEqual)
export function adminProofRequired(pathname: string): boolean;  // true for admin surfaces, false for agent/public/token/webhook paths
```
`adminProofRequired` reuses the negative of `isPublicOriginBypassPath` / `isPublicOriginBypassApiPath` from `src/lib/origin-guard.ts` **plus** excludes `/api/agent/*`, `/api/mcp`, `/api/stripe/webhook`, `/api/google/*`, `/api/cron/*` (which authenticate by their own bearer/signature, not the admin session).

### Enforcement points
Primary choke point is `src/middleware.ts` (already runs for `/api/:path*` and all matched pages). Extend `middleware()`:
```ts
export async function middleware(request) {
  const blocked = guardDirectWorkerPageRequest(request);
  if (blocked) return blocked;
  const url = new URL(request.url);
  if (adminProofRequired(url.pathname) && adminProofEnforced()   // env flag, see rollout
      && !(await verifyAdminProxyProof(request))) {
    return new NextResponse("Not Found", { status: 404 });
  }
  return NextResponse.next();
}
```
Middleware becomes `async` (already edge; verify OpenNext supports async edge middleware — it does for this target since `middleware.ts` stays on the edge runtime). **Defense-in-depth kept in handlers:** admin API route handlers continue calling `guardDirectWorkerApiRequest`; optionally add a `guardAdminApiRequest(request)` that also calls `verifyAdminProxyProof` for the highest-value mutating routes (finance/settings) so a middleware regression can't silently expose them.

### Config / secrets / env keys
- New: `ADMIN_PROOF_SECRET` (Pages proxy env + Worker secret).
- New: `ADMIN_PROOF_ENFORCE` (Worker var, `"1"` to hard-enforce) — enables phased rollout (fail-open → fail-closed) without a code redeploy.

### Files touched
`pages-proxy/_worker.js`, `src/middleware.ts`, `src/lib/admin-proxy-auth.ts` (new), optionally `src/lib/origin-guard.ts` (export the surface-classification helpers), and the highest-value admin route handlers if `guardAdminApiRequest` is added.

### Test plan
- `src/lib/admin-proxy-auth.test.ts` (new): sign/verify round-trip; wrong method/path → fail; expired ts (> skew) → fail; missing secret → fail (never crash); tampered sig → fail; constant-time path exercised.
- `src/lib/admin-surface-classification.test.ts` (or extend `origin-guard.test.ts`, run via `npm run test:origin-guard`): `adminProofRequired` returns false for `/api/agent/*`, `/api/mcp`, `/proposal/*`, `/p/*`, `/book/*`, `/api/stripe/webhook`, `/api/google/*`, `/api/cron/*`; true for `/finance`, `/api/settings`, `/api/clients/x`, `/projects`.
- Extend `scripts/production-smoke.mjs`: assert that a direct authenticated-looking request without the proof header to an admin API is rejected once `ADMIN_PROOF_ENFORCE=1` (post-cutover check).

### Rollout / rollback
1. Deploy proxy that **sets** the header (no app enforcement yet) + set `ADMIN_PROOF_SECRET` in both places.
2. Deploy app with verify code but `ADMIN_PROOF_ENFORCE` unset → log-only / fail-open; watch `observability` logs for admin requests missing/failing proof (catches any admin path the classifier misses).
3. After a clean window, set `ADMIN_PROOF_ENFORCE=1`.
Rollback: unset `ADMIN_PROOF_ENFORCE` (instant, no redeploy) → back to proxy-only. Full rollback: redeploy prior proxy/app. Risk: a misclassified public route getting the proof requirement would 404 legitimately-public traffic — the phased flag + log-only window mitigates this.

---

## Section 3 — L7: Referrer-Policy on `/proposal/**`

### Problem
Proposal token lives in the URL (`/proposal/:token?accepted=1`); the global `referrer-policy: strict-origin-when-cross-origin` (`pages-proxy/_worker.js:16`) can leak the token path via `Referer` on outbound navigations. Portal already strips its token into a cookie (`/p/:token`); proposals do not.

### Design
Set a **stricter** `Referrer-Policy: no-referrer` for proposal surfaces. The Pages proxy is authoritative because `applySecurityHeaders` (line 107, called at line 476) runs **after** the origin response and would clobber any app-set header. Implement in the proxy, immediately after `applySecurityHeaders(responseHeaders)` in the main fetch handler:
```js
if (incomingUrl.pathname.startsWith("/proposal/") || incomingUrl.pathname.startsWith("/api/proposal/")) {
  responseHeaders.set("referrer-policy", "no-referrer");
}
```
Also apply to the redirect responses that carry the token (`redirectResponse` currently spreads static `SECURITY_HEADERS`); for proposal-path redirects, override to `no-referrer`. Simplest robust approach: add a `referrerPolicyFor(pathname)` helper used by both `redirectResponse` and the main path.

Optional app-side belt-and-suspenders: the proposal accept flow can `redirect()` to strip `?accepted=1`/token from the visible URL (App Router route handler), but the proxy header is the load-bearing fix.

### Config / secrets
None. Pure header logic in `pages-proxy/_worker.js`.

### Files touched
`pages-proxy/_worker.js` only. (Optionally `src/app/proposal/[token]/*` for the post-accept redirect.)

### Test plan
No unit-test harness exists for the proxy; cover via:
- Extend `scripts/production-smoke.mjs` (or a new `scripts/proxy-headers-smoke.mjs`): assert `referrer-policy: no-referrer` on `GET /proposal/<any>` and `strict-origin-when-cross-origin` elsewhere.
- Manual curl check documented in `docs/deployment-live-testing.md`.

### Rollout / rollback
Ships with `npm run deploy:pages-proxy`. Header-only, no data risk. Rollback: redeploy prior proxy. Independent of Sections 1–2, can ship first (lowest risk).

---

## Section 4 — L8: CSP `script-src` via Next.js nonce (Next 16 App Router on OpenNext)

### Problem
The proxy strips the origin CSP and sets a minimal static one with no `script-src`/`default-src` (`pages-proxy/_worker.js:18,473`). XSS is mitigated by React escaping only. Fix: add `script-src 'self' 'nonce-<per-request>' 'strict-dynamic'` with a real per-request nonce, without breaking hydration.

### Design — nonce generation + propagation
Read `node_modules/next/dist/docs/` for the exact Next 16 nonce contract before implementing; the shape below matches the documented App Router pattern (middleware generates nonce, exposes it via a request header, Next injects it into framework/inline scripts, server components read it for custom `<script>`).

1. **Generate in `src/middleware.ts`** (edge, per request): `const nonce = crypto.randomUUID()` → base64. Build the full CSP string including `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; ...`. Set it on a cloned **request** header (`x-nonce` and the `content-security-policy` request header Next reads) via `NextResponse.next({ request: { headers } })`, and set the response `Content-Security-Policy` header to the same value.
2. **Consume in the app**: server components / `layout.tsx` read the nonce from `headers()` (`(await headers()).get('x-nonce')`) and pass it to any manual `<script nonce={nonce}>`. Next automatically nonces its own bootstrap/inline scripts from the CSP request header.
3. **Proxy composition** (`pages-proxy/_worker.js`): the proxy must **stop clobbering** the app CSP on HTML document responses. Change the flow at lines 473-476: instead of unconditionally `responseHeaders.delete("content-security-policy")` then applying the static one, **preserve an app-provided CSP** when present (it carries the nonce) and only inject the static baseline CSP when the origin sent none (e.g. non-HTML, error, or cached responses). Keep the non-`script-src` hardening directives (`base-uri`, `object-src`, `frame-ancestors`, `upgrade-insecure-requests`) — merge them into the app CSP so a single header carries both. Cleanest: have the **app** emit the full directive set (including base-uri/object-src/frame-ancestors) so the proxy can pass it through verbatim for documents, and the proxy's static CSP remains only the fallback.

### Hydration + caching risks (must handle)
- **Nonce mismatch → hydration break.** The nonce in the CSP header and the nonce on emitted scripts must be identical. Only generate the nonce in **one** place (middleware) and never regenerate downstream. Do not set the nonce in a React render path.
- **Cached public booking pages** (`pages-proxy/_worker.js:429-498` caches `/book/*` HTML for 60s under `caches.default`). A per-request nonce baked into a cached HTML body would be reused across requests → CSP header (regenerated per request) would not match the frozen script nonces → all scripts blocked. **Resolution:** do **not** apply a nonce'd `script-src` to cacheable public booking responses. For the schedule host / `/book/*`, use a nonce-free `script-src 'self'` (no `'strict-dynamic'`, no nonce) so the cached body stays valid. Gate nonce generation in middleware to non-cacheable routes (reuse the predicate mirroring `canCachePublicBookingPage`).
- **`'strict-dynamic'`** drops `'self'` allowlisting in supporting browsers; verify all first-party scripts are loaded through nonced bootstrap. If any static `/brand` or third-party inline breaks, fall back to `script-src 'self' 'nonce-…'` without `'strict-dynamic'`.
- **OpenNext specifics:** confirm middleware runs before the cached asset short-circuit and that `NextResponse.next({ request })` header mutation survives the OpenNext adapter. Validate in `npm run preview` (local OpenNext) before deploy.

### Config / secrets / env keys
- Optional `CSP_REPORT_ONLY` (Worker var): when set, emit `Content-Security-Policy-Report-Only` instead of enforcing, for a safe observation window.
- New helper module `src/lib/csp.ts`: `buildCsp(nonce: string | null): string`.

### Files touched
`src/middleware.ts`, `src/lib/csp.ts` (new), `src/app/layout.tsx` (read nonce for any manual scripts), `pages-proxy/_worker.js` (stop clobbering app CSP; keep static as fallback; skip nonce for cached `/book/*`).

### Test plan
- `src/lib/csp.test.ts` (new): `buildCsp(nonce)` contains `script-src` with the nonce and hardening directives; `buildCsp(null)` yields the cache-safe variant.
- `src/middleware.test.ts` (new or extend): asserts a nonce is generated for a Studio document route and omitted for `/book/*` cacheable path; response CSP matches request CSP nonce.
- Manual + `npm run preview`: load Studio, confirm no CSP violations in console, hydration succeeds; load `/book/*` twice (cache HIT) and confirm scripts still execute. Extend `scripts/production-smoke.mjs` to assert `script-src` present on a Studio response and that two requests to a non-cached route carry **different** nonces.

### Rollout / rollback
1. Ship in **report-only** (`CSP_REPORT_ONLY=1`) — observe violations via `observability` logs. 2. Fix any flagged inline/script. 3. Flip to enforce. Rollback: set `CSP_REPORT_ONLY=1` (or revert proxy to re-apply the old static minimal CSP). Highest hydration-risk item in the phase — keep behind the report-only flag and validate in `preview` first.

---

## Section 5 — Ops drills: D1 restore + agent-token rotation + "who has access" inventory

### 5a. D1 restore drill
Machinery already exists: `scripts/restore-local-from-d1-backup.mjs` (`npm run db:restore-local:d1 -- --dry-run | --yes`), backup pipeline in `scripts/backup.mjs` / `backup-data.sh`, reconciliation `scripts/reconcile-backups.mjs`, docs in `docs/backups.md` and `docs/ops-stabilization-checklist.md:63-81`. What's missing is a **documented, scheduled, evidence-producing drill** and a **remote-restore rehearsal** (restore into a scratch D1, not just local SQLite).

Deliverables:
- Extend `docs/ops-stabilization-checklist.md` "Backup / Restore Drill" with a **quarterly restore-verification runbook**: run `npm run db:restore-local:d1 -- --dry-run` then `--yes`, confirm the JSON report (project/client counts ≥ current prod, Studio tables present, `local-before-d1-restore-*.db` snapshot written), and record pass/date in the checklist + Obsidian source-of-truth note.
- New optional script `scripts/restore-verify-d1.mjs` (thin wrapper): runs the restore against a throwaway `--database /tmp/d1-restore-drill.db --source .../d1/latest.sql --yes`, asserts row-count thresholds, exits non-zero on failure, writes a stamped report to `.../logs/`. Add `npm run drill:restore` to `package.json`.
- Add a backup-freshness assertion is already in `deploy:preflight` (`<=36h` D1 export). Cross-reference it here; do not duplicate.

Test plan: `scripts/restore-verify-d1.test.mjs` (mirror existing `scripts/*.test.mjs` style, e.g. `rollback-deploy.test.mjs`) covering threshold pass/fail and report shape. No prod side effects (throwaway db).

### 5b. Agent-token rotation + "who has access" inventory
This closes `ops-stabilization-checklist.md:113` item 6 and `security-model.md:24-25`.

Deliverables (documentation, not code):
- New section in `docs/studio-agent-access.md` (or a new `docs/access-inventory.md`) — the **rotation runbook** for `STUDIO_AGENT_API_TOKEN`:
  1. Generate new 256-bit token. 2. Set Worker secret (`wrangler secret put STUDIO_AGENT_API_TOKEN`). 3. Update keychain `reese-studio-agent-api-token` + `.env.local`. 4. Update any agent clients (Marcus/Brunel/MCP configs). 5. `npm run smoke:production` to confirm. 6. Revoke old (token is single-value; rotation = overwrite, so step 2 is the cutover). Note the accepted residual risk (single shared bearer) and the upgrade path to scoped credentials before any external agent (`route-access-audit.md:118`).
- **"Who has access" inventory table** enumerating every secret/credential, its store, and holders:

| Credential | Store(s) | Holder / consumer | Rotation trigger |
| --- | --- | --- | --- |
| `STUDIO_AGENT_API_TOKEN` | Worker secret; keychain `reese-studio-agent-api-token`; `.env.local` | trusted agents (MCP/REST), smoke | suspected exposure; scheduled |
| `ORIGIN_PROXY_SECRET` | Pages env; Worker secret | proxy→origin trust | proxy/origin compromise |
| `ADMIN_PROOF_SECRET` (new, §2) | Pages env; Worker secret | admin authz proof | admin-path compromise |
| `R2_URL_SIGNING_SECRET` (new, §1) | Worker secret; `.env.local` | signed asset URLs | asset-link leak |
| `ADMIN_SESSION_SECRET` | Pages env | admin session HMAC | session-forgery risk |
| `GOOGLE_CLIENT_SECRET` | Pages env | admin OAuth | Google console rotation |
| `SCHEDULER_LINK_SECRET` / `AUTH_SECRET` | Worker secret | scheduler/questionnaire link HMAC | link-forgery risk |
| `STRIPE_*`, `RESEND_*` | Worker secret | payments, email | provider rotation |
| `CLOUDFLARE_API_TOKEN` | keychain `reese-crm-cloudflare-api-token` | deploy/backup | scheduled |

- Add a checkbox to `ops-stabilization-checklist.md` "Next Branch Plan" item 6 marking it complete when the inventory + rotation runbook land, and an assertion in `scripts/studio-agent-access-docs.test.mjs` that the doc contains the rotation runbook + inventory headings (that test already guards doc content).

### Files touched
`docs/ops-stabilization-checklist.md`, `docs/studio-agent-access.md` (or new `docs/access-inventory.md`), `docs/backups.md` (cross-link), `scripts/restore-verify-d1.mjs` (new), `scripts/restore-verify-d1.test.mjs` (new), `package.json` (`drill:restore`), `scripts/studio-agent-access-docs.test.mjs` (extend).

### Rollout / rollback
Docs + scripts only; no runtime impact, no rollback risk. Land independently and early.

---

## Section 6 — Dead-code cleanup for the finance kill-switch

### Problem (Info finding)
Six blocked finance `*FromAgent` functions keep their **full original bodies as unreachable code** after an unconditional `return requireTyler…()`. A future refactor that makes the guard conditional could silently re-expose live mutation code. Exact locations:

| Function | File:line | Guard helper |
| --- | --- | --- |
| `createInvoiceFromAgent` | `src/lib/sales.ts:2620` | `requireTylerApprovalForAgentFinance` (`sales.ts:714`) |
| `updateInvoiceFromAgent` | `src/lib/sales.ts:2696` | same |
| `recordInvoicePaymentFromAgent` | `src/lib/sales.ts:3098` | same |
| `updateInvoicePaymentFromAgent` | `src/lib/sales.ts:3107` | same |
| `recordSchedulerBookingPaymentFromAgent` | `src/lib/scheduler.ts:1039` | `requireTylerApprovalForAgentSchedulerPayment` (`scheduler.ts:266`) |
| `updateSchedulerBookingPaymentFromAgent` | `src/lib/scheduler.ts:1051` | same |

Each throws as the **first statement** (verified in QA — `qa-…2026-07-04.md:51`), so the guard is real; the dead bodies below the `return` are the only issue.

### Design
Reduce each of the 6 functions to just the guard call (delete the unreachable body). Keep the exported signature and the descriptive throw message identical so MCP/REST error text and tool descriptions in `docs/studio-agent-access.md:205-212` remain accurate. The `requireTyler…` helpers already `throw` (`sales.ts:714-716`) — `never` return type is correct; change `return requireTyler…(msg)` to `requireTyler…(msg)` (statement) where lint prefers, or keep `return` for the explicit `never`.

Before deleting, confirm no now-unused imports/helpers are left dangling (e.g. `centsToFormMoney`, `assertAgentProjectSource`, `cleanAgentText`, `writeInvoicePaymentFromAgent`, `createInvoiceFromForm`) — several are used by **admin (non-agent)** paths, so most stay. Remove only symbols that become truly unreferenced after the deletion (`eslint` + `tsc noUnusedLocals` will flag them). Do **not** touch the admin `createInvoiceFromForm` / `writeInvoicePaymentFromAgent` paths — those are the live, human-approved mutations.

### Alternative (documented, not chosen)
Gate the body behind an explicit, tested approval flag (e.g. `FINANCE_AGENT_WRITES_ENABLED`). Rejected for Phase 6: adds a re-enable switch to a surface Tyler has deliberately closed; deletion is safer and matches the QA recommendation ("delete the dead bodies").

### Config / secrets
None.

### Files touched
`src/lib/sales.ts`, `src/lib/scheduler.ts`.

### Test plan
Existing coverage already asserts the throw: `src/lib/studio-mcp.test.ts`, `src/lib/agent-proposal.test.ts` (and agent route tests). Verify they still pass unchanged. Add explicit, minimal unit tests if not already present:
- `src/lib/agent-finance-guard.test.ts` (new or fold into existing): each of the 6 functions rejects with the expected message and performs **no** DB write (assert with a spy/fake `db`). This locks the behavior so a future body re-add can't pass tests silently.
Run `npm run test` (target 172/172 baseline stays green), `npm run lint`, `npm run build`.

### Rollout / rollback
Pure removal of unreachable code — behavior-preserving. Ships with any Phase 6 app deploy. Rollback trivial (revert). Zero runtime risk; lowest-risk item.

---

## Ordered task breakdown (for implementation agents)

Each task is independently shippable; ordering respects dependencies and risk. Risk/effort: **E** = effort (S/M/L), **R** = risk (Low/Med/High).

| # | Task | Depends on | Files (primary) | E | R |
| --- | --- | --- | --- | --- | --- |
| 1 | **§6 finance dead-code deletion** — reduce 6 `*FromAgent` fns to guard call; prune newly-unused symbols; add `agent-finance-guard.test.ts`. | — | `src/lib/sales.ts`, `src/lib/scheduler.ts` | S | Low |
| 2 | **§3 Referrer-Policy on `/proposal/**`** — `referrerPolicyFor()` in proxy; apply post-`applySecurityHeaders` and in proposal redirects; smoke assertion. | — | `pages-proxy/_worker.js`, `scripts/production-smoke.mjs` | S | Low |
| 3 | **§5 ops drills + access inventory** — restore-verify script + test, `drill:restore`, rotation runbook, who-has-access table, doc-content test. | — | `scripts/restore-verify-d1.mjs`(+test), `docs/*`, `package.json` | M | Low |
| 4 | **§1a R2 storage primitives** — `asset_objects` migration + schema; `src/lib/assets.ts` (`putAsset`/`getAssetObject`/`deleteAsset`/`getAssetMeta`); `R2_URL_SIGNING_SECRET` fail-closed; `assets.test.ts`; `cf:typegen`. | — | `src/db/*`, `src/lib/assets.ts` | M | Med |
| 5 | **§1b R2 serving route + signed URLs + scope mapping** — `/api/assets/[...key]` GET; `signAssetUrl`/`verifyAssetUrl`; portal/proposal scope enforcement; origin-guard + proxy public-path + rate-limit wiring; route test. | 4 | `src/app/api/assets/[...key]/route.ts`, `src/lib/assets.ts`, `src/lib/origin-guard.ts`, `pages-proxy/_worker.js` | M | Med |
| 6 | **§2 M4 admin proxy proof** — proxy sets `x-reese-admin-proof` after session check + strips inbound; `src/lib/admin-proxy-auth.ts`; async middleware enforcement behind `ADMIN_PROOF_ENFORCE`; `ADMIN_PROOF_SECRET` in both envs; classification + verify tests; phased log-only rollout. | 2 (proxy edits) | `pages-proxy/_worker.js`, `src/middleware.ts`, `src/lib/admin-proxy-auth.ts`, `src/lib/origin-guard.ts` | L | Med |
| 7 | **§4 CSP nonce (L8)** — `src/lib/csp.ts`; nonce in middleware (skip cacheable `/book/*`); proxy stops clobbering app CSP (fallback only); layout reads nonce; `CSP_REPORT_ONLY` report-only rollout; csp/middleware tests + `preview` validation. | 6 (middleware now async) | `src/middleware.ts`, `src/lib/csp.ts`, `src/app/layout.tsx`, `pages-proxy/_worker.js` | L | High |

**Suggested delivery order:** 1 → 2 → 3 (fast, low-risk, independent) → 4 → 5 (R2 prerequisite for Phase 7) → 6 → 7 (highest hydration/caching risk last, behind report-only). Tasks 6 and 7 both edit `pages-proxy/_worker.js` and `src/middleware.ts`; sequence them to avoid merge churn (6 makes middleware async; 7 builds on that). Every task ends with `npm run lint && npm run build && npm run test`; proxy/app changes additionally validated in `npm run preview` and `npm run smoke:production` after deploy, per the deploy gate in `ops-stabilization-checklist.md`. No merge to `main` / deploy without explicit Tyler approval.

### Cross-cutting secrets summary (set before enforcement)
`ADMIN_PROOF_SECRET` (Pages env + Worker), `R2_URL_SIGNING_SECRET` (Worker), plus feature flags `ADMIN_PROOF_ENFORCE` and `CSP_REPORT_ONLY` (Worker vars). Confirm no public domain is attached to R2 bucket `studio-bythereeses`. Run `npm run cf:typegen` after adding the first R2 code use.
