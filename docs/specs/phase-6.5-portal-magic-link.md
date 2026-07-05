# Phase 6.5 — Portal self-service email magic-link login

**Status:** Design spec (no implementation). Draft 2026-07-05.
**Owner gate:** No merge/deploy without Tyler approval (Phase 6+ rule, roadmap.md). Fable AI review before branch.
**Roadmap ref:** `docs/roadmap.md` §"Phase 6.5". Depends on Phase 6 hardening (proxy proof/CSP, origin guard).

---

## 0. Problem and goal

The portal security foundation already exists in `src/lib/portal.ts`:

- 256-bit random tokens (`randomBytes(32).toString("base64url")`), SHA-256 at rest (`hashToken`), unique `token_hash`.
- 30-day httpOnly `portal_project_id` + `portal_token_id` session cookies set by `authenticatePortalToken`.
- Expiry / revocation (`expiresAt`, `revokedAt`), no IDOR (`requirePortalProject` re-validates project scope on every load).
- `/p/[token]/route.ts` exchanges a token in the URL for the session cookies.

**Gap:** links are minted by admin/agent (`createPortalLink` / `createPortalLinkFromAgent`) and delivered manually. There is **no self-service path**. `src/app/portal/page.tsx` empty state literally says "Open a secure portal link from Tyler."

**Goal:** a public page where a client enters their email → if it matches a project contact, they receive a **single-use, short-TTL magic link** by email → clicking it establishes the existing 30-day portal session. Reuse the existing token+session machinery and Resend infra; invent no new crypto.

This phase also folds in two Phase-6 follow-ups that live on this exact surface (proxy portal login-wall for `/portal/proposals/:id`, and the proxy `verifyAdminSession` non-constant-time compare).

**Non-goals:** password auth, account creation, SMS delivery (Phase 8), Turnstile (noted as future), changing the 30-day session model.

---

## 1. Public request page + endpoint

### 1.1 Files

| File | New/Mod | Purpose |
| --- | --- | --- |
| `src/app/portal/login/page.tsx` | new | GET — "enter your email" form (server component, `dynamic = "force-dynamic"`). |
| `src/app/api/portal/request-link/route.ts` | new | POST — accepts email, triggers `requestPortalMagicLink`, returns uniform response. |
| `src/app/portal/login/verify/[token]/route.ts` | new | GET — consumes the magic-request token, establishes the portal session, redirects to `/portal`. |
| `src/lib/portal.ts` | mod | add `requestPortalMagicLink`, `consumePortalMagicLink`, `resolveActiveProjectsForEmail`, `establishPortalSessionForToken`. |
| `src/lib/email.ts` | mod | add exported `sendPortalMagicLinkEmail`. |
| `src/db/schema.ts` + `migrations/0084_*` | mod | add `kind`, `consumedAt` to `portalAccessTokens`. |
| `src/lib/admin-proxy-auth.ts` | mod | **[B1]** exempt the `/portal` subtree + `/api/portal/request-link` in `adminProofRequired` (falls through to `return true` today → the proxy never mints a proof for these routes → whole flow 404s under `ADMIN_PROOF_ENFORCE=1`, warns under `log`). |
| `src/lib/admin-surface-classification.test.ts` | mod | **[B1]** update the drift test that pins `adminProofRequired` against the proxy's public-path predicates. |
| `src/lib/origin-guard.ts` | **UNCHANGED** | **[B2]** do NOT add the login/verify pages or `/api/portal/request-link` to `PUBLIC_PAGE_PREFIXES`/`PUBLIC_API_PREFIXES` — see §1.4. Keeping them origin-secret-gated forces all traffic through the proxy's per-IP `requestLink` limiter. |
| `pages-proxy/_worker.js` | mod | `isPortalPublicPath` broaden; `requestLink` rate-limit kind; `constantTimeEqual` for `verifyAdminSession`. |

### 1.2 GET `/portal/login` (`page.tsx`)

Server component. Renders a minimal form styled like the existing empty state (`bg-[var(--surface)]`, brand tokens). No client JS required beyond native form POST.

```tsx
export const dynamic = "force-dynamic";
// Reads ?sent=1 and ?error=rate|config to show the uniform confirmation / soft errors.
// <form method="POST" action="/api/portal/request-link">
//   <input type="email" name="email" required autocomplete="email" inputmode="email" />
//   <button>Email me a sign-in link</button>
// Feature-flag: if PORTAL_MAGIC_LINK_ENABLED !== "1", render a fallback that
// matches today's copy ("Open a secure portal link from Tyler") and no form.
```

The confirmation copy after POST is **always** the same: *"If that email is on file, we've sent a sign-in link. Check your inbox."* (see §3.1). The page never reveals whether the address matched.

### 1.3 POST `/api/portal/request-link/route.ts`

```ts
export const runtime = "nodejs";          // needs node:crypto (hashToken) + db
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Pre-response work is ONLY: flag check, formData parse, fire the deferred task.
  // ALL match-correlated work (per-email rate check, resolution, mint, send) runs
  // AFTER the response is committed, on the waitUntil task — see §3.1 [B3].
  if (process.env.PORTAL_MAGIC_LINK_ENABLED !== "1") {
    return uniformResponse(request);       // flag off → identical no-op response
  }
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const ip = clientIpFromHeaders(request.headers);   // x-forwarded-for[0]

  // [N1] On Workers/OpenNext an unawaited promise is CANCELED when the response
  // returns — the send/mint would silently never run. Register the deferred task
  // with the platform waitUntil (pattern: getCloudflareContext() in src/lib/assets.ts).
  const { ctx } = getCloudflareContext();
  ctx.waitUntil(requestPortalMagicLink({ email, ip }));   // never throws to caller; see §3

  return uniformResponse(request);                     // 303 → /portal/login?sent=1 (browser)
                                                       // or 200 JSON {ok:true} for fetch callers
}
```

`uniformResponse` is a single code path returning the same status/body regardless of match. Content negotiation: HTML form submit → 303 redirect to `/portal/login?sent=1`; `Accept: application/json` → `{ ok: true }`. Both branches identical for match / no-match / rate-limited-soft (see §3.2 for the hard 429 exception at the proxy).

> **[N1] `waitUntil` is mandatory, not an optimization.** The origin runs on OpenNext/Cloudflare; a bare `requestPortalMagicLink(...)` promise that the handler does not await is dropped the moment the `Response` is returned, so **no email is ever sent**. It must be registered via `getCloudflareContext().ctx.waitUntil(...)`. `requestPortalMagicLink` still must never throw (any internal failure is swallowed + logged), because a rejected `waitUntil` task is invisible to the client and must not surface. A Node/local fallback path (no Cloudflare context) awaits nothing before responding and schedules via `queueMicrotask`/`setImmediate` for parity.

### 1.4 Three classifiers must agree — proxy admin-gate, admin-proof, origin-guard

There are **three** independent path classifiers to reconcile, not one. Getting any wrong breaks the flow:

**(1) Proxy admin Google-session gate — `pages-proxy/_worker.js` `isStudioPublicPath`/`isPortalPublicPath` (§4.1).** Broaden `isPortalPublicPath` to the whole `/portal` subtree (subsumes `/portal/login`, `/portal/login/verify/*`) and add `/api/portal/request-link` explicitly to the studio-public set. Without this the request/verify pages 303 to `/admin/login` (same class of bug as §4.1).

**(2) Admin-proof classifier — `src/lib/admin-proxy-auth.ts` `adminProofRequired` [B1, BLOCKING].** This is a *separate* Phase-6 (M4) defense-in-depth layer the original spec omitted. Today it exempts only `path === "/portal"` and `path.startsWith("/portal/proposals/")`, then **falls through to `return true`** (line 199/231). So `/portal/login`, `/portal/login/verify/*`, and `POST /api/portal/request-link` would be classified as admin surfaces → the origin middleware expects an `x-reese-admin-proof` the proxy never stamps for them → under `ADMIN_PROOF_ENFORCE=1` the entire login flow **404s**, and under `log` mode it emits `console.warn` on every hit. Fix: replace the narrow `/portal` exemption with the subtree, and exempt the request endpoint:

```ts
// src/lib/admin-proxy-auth.ts — client portal is public, client-reachable.
if (path === "/portal" || path.startsWith("/portal/")) return false;   // was: /portal exact + /portal/proposals/
if (path.startsWith("/p/")) return false;
if (path === "/api/portal/request-link") return false;                 // self-service request endpoint
```

Update the drift test `src/lib/admin-surface-classification.test.ts` so the two layers stay pinned together.

**(3) Origin-guard direct-worker block — `src/lib/origin-guard.ts` [B2, BLOCKING — do NOT touch].** Leave `PUBLIC_PAGE_PREFIXES` / `PUBLIC_API_PREFIXES` **as-is**. Do **not** add `/portal/login`, the verify page, or `/api/portal/request-link` to the bypass lists.

> **Why the asymmetry with `/p/`:** `/p/` must be origin-bypass-public because a browser can legitimately hit the worker origin directly for those. But `/api/portal/request-link` is the **only** endpoint with a per-IP cap, and that cap lives *in the proxy's in-memory limiter* (§3.2). If we bypassed the origin secret, an attacker could POST straight to `*.workers.dev/api/portal/request-link`, skip the proxy entirely, and **email-bomb** any address with no per-IP limit at all. Keeping it origin-secret-gated means a direct `*.workers.dev` POST → 404 (`guardDirectWorkerApiRequest`), forcing every real request through `studio.bythereeses.com` and therefore through the `requestLink` limiter. The proxy always injects `x-reese-origin-secret`, so no legitimate traffic breaks. The verify GET page is likewise left gated for the same reason (its consumption is per-IP `tokenAccess`-limited at the proxy).

---

## 2. Email → project resolution

### 2.1 Data path

`clients.email` is `NOT NULL UNIQUE` (schema.ts:12). A client links to projects via `projectParticipants` (`clientId` → `projectId`). A client may sit on multiple projects (wedding + engagement, multi-year, family). Only `projects.status = "active"` projects should be reachable (schema default `"active"`; archived/cancelled projects should not mint fresh sessions).

```ts
// src/lib/portal.ts
async function resolveActiveProjectsForEmail(email: string): Promise<Array<{
  clientId: string; projectId: string; projectName: string;
}>> {
  const normalized = email.trim().toLowerCase();       // clients.email is stored canonical (migration 0033/0052)
  return db
    .select({ clientId: clients.id, projectId: projects.id, projectName: projects.name })
    .from(clients)
    .innerJoin(projectParticipants, eq(projectParticipants.clientId, clients.id))
    .innerJoin(projects, eq(projects.id, projectParticipants.projectId))
    .where(and(eq(clients.email, normalized), eq(projects.status, "active")));
}
```

### 2.2 Multi-project decision — **one email, one single-use token per active project**

**Decision:** when the email matches, mint **one short-TTL, single-use magic-request token per active project** and send **one email** whose body lists a button per project ("View {project name}"). Each button links to `/portal/login/verify/<token>` where each token is scoped to a specific `(clientId, projectId)`.

**Why this over a chooser page:**

- **Reuses the existing model 1:1.** The live session cookie is single-project (`portal_project_id`). Per-project tokens map cleanly onto `createPortalLink` and `authenticatePortalToken` with zero new session concepts. A chooser page would require an *intermediate authenticated state* ("email verified, project not chosen") — a second session type to design, store, and secure — for marginal UX gain.
- **Single-use stays clean.** Each link consumes exactly its own token; no shared token that must survive a chooser round-trip.
- **The only disclosure is the recipient's own project names, to their own proven inbox.** No enumeration or cross-tenant leak (see §3.1). Receiving the email already proves control of the address.
- Common case is exactly one active project → one button, indistinguishable from a classic magic link.

**Cap:** list at most `PORTAL_MAGIC_LINK_MAX_PROJECTS` (default 5) projects; if a client somehow exceeds it (data-quality signal), send the 5 most recently created and log a warning. Do not fan out unbounded tokens/emails.

---

## 3. Security (crux)

### 3.1 No email enumeration — uniform, timing-flat response

**Response uniformity.** `POST /api/portal/request-link` returns the identical status + body for match, no-match, and malformed-but-parseable email. Copy: *"If that email is on file, we've sent a sign-in link."* The response is produced by one `uniformResponse` helper so the two branches cannot diverge by accident.

**Timing [B3 — corrected].** Enumeration oracles come from (a) DB-lookup cost, (b) hashing/insert cost, (c) email-send latency, (d) early returns. The design's rule is a hard split: **the only work on the request's critical path (before the response is committed) is `formData` parse + registering the deferred task.** *Everything* email-correlated — the per-email rate check (which needs `clientId` from a D1 lookup), `resolveActiveProjectsForEmail`, the throwaway hash, minting/insert, and the Resend send — runs on the deferred `waitUntil` task, i.e. **after** the response has already gone out. This is what removes the latency oracle: a matching email and a non-matching email produce byte-identical responses at identical time because neither has done any match-dependent work yet.

Ordering inside the deferred `requestPortalMagicLink` task (all post-response):

1. **Per-email rate check on the deferred path [B3].** The earlier draft put this pre-response, but it keys on `clientId`, which requires the very D1 lookup the design defers — that would reintroduce the exact oracle this section exists to kill. It moves onto the deferred task. Semantics are unchanged (it still caps live tokens per client per window); only its *position* changes, and since it now runs after the response it can never influence client-visible latency.
2. **`resolveActiveProjectsForEmail`** — the match/no-match branch point, deferred.
3. **Equalize the crypto path** — on no-match, perform one throwaway `hashToken(randomBytes(32)…)` so match and no-match do comparable hashing work. This too is deferred, so it is purely for defense-in-depth against any observer of the task's own duration (e.g. logs), not for request latency (which is already equalized by step 0).
4. **Mint + insert + send** (match only), via Resend fire-and-forget within the task.

Step 0 (critical path) for **every** branch — flag-off, no-match, match, and per-email-capped — is the identical constant sequence: parse `formData`, call `getCloudflareContext().ctx.waitUntil(requestPortalMagicLink(...))`, return `uniformResponse`. No branch returns early with different work.

The one deliberate, non-email signal is the proxy's per-IP 429 (§3.2): it is keyed on IP, not email, and fires *before* the handler runs, so it reveals request volume from an IP but nothing about whether any given address exists.

> Note: perfect constant-time in a GC'd runtime is unattainable; the design removes the *large, email-correlated* differentiators (email send, DB rows found, per-email count) entirely from the request's critical path by deferring them past the response, and equalizes the hashing step. This matches the project's existing "practical baseline, not a distributed abuse platform" posture (security-model.md).

**Activity log privacy:** log the *request* by IP + hashed-email-fingerprint, not raw email in metadata where a match occurred vs not (see §5). Do not log "no match for X" in a way that becomes an oracle via any client-visible surface.

### 3.2 Rate limiting — per-IP (proxy) AND per-email (D1)

**Per-IP (existing in-memory proxy limiter, `pages-proxy/_worker.js`).** Add a `requestLink` kind:

```js
const RATE_LIMITS = {
  // ...
  requestLink: { max: 5, windowSeconds: 900 },   // 5 requests / 15 min / IP
};
// rateLimitKind(): POST /api/portal/request-link  → "requestLink"
//                  GET  /portal/login/verify/*     → "tokenAccess" (reuse; token consumption)
```

`rateLimitKind` currently keys `tokenAccess` off `/p/`, `/portal`, `/proposal/`. Because `isPortalPublicPath` broadens to the `/portal` subtree, guard ordering: match `/api/portal/request-link` (method POST) → `requestLink` **before** the generic `/portal` → `tokenAccess` branch. The verify GET route stays under `tokenAccess`.

**Per-email (origin, D1-backed, cannot live in per-IP memory).** Inside the **deferred** `requestPortalMagicLink` task (post-response, per §3.1 [B3]), after resolving the client and before minting, count recent magic-request tokens for the resolved client and no-op past the cap:

```ts
// runs on the waitUntil task, NOT the request critical path (§3.1)
const recent = await db.select({ n: count() })
  .from(portalAccessTokens)
  .where(and(
    eq(portalAccessTokens.clientId, clientId),
    eq(portalAccessTokens.kind, "magic_request"),
    gt(portalAccessTokens.createdAt, isoNMinutesAgo(15)),
  ));
if (recent[0].n >= PORTAL_MAGIC_LINK_PER_EMAIL_MAX /* 3 */) return; // silent noop; response already sent
```

**[N3] Counting semantics — request-batches, not raw tokens.** A single request for a client on K active projects mints K tokens. Counting raw `magic_request` rows would let `PORTAL_MAGIC_LINK_PER_EMAIL_MAX=3` be exhausted by a *single* legitimate request from a 3-project client. Two options, pick per data reality:
- **(a) Cap requests, not tokens:** count `DISTINCT` mint-batches (add a `requestBatchId` shared across the K tokens of one request, count distinct batches in the window). Preferred — the cap then means "3 emails per client per 15 min" regardless of project count.
- **(b) Scale the raw cap** by typical project count. Simpler but fragile.
Default to (a); the batch id is a `crypto.randomUUID()` stamped into each row of a request (store in `label` suffix or a small dedicated column if added). Since the K tokens of one request all share `clientId`, the per-email check must run **once per request** (after resolution), not once per project.

This is the durable per-email cap (survives worker recycle, which resets the in-memory IP buckets). **Note the distributed option:** the in-proxy limiter is in-memory and per-isolate (`rateLimitBuckets` Map), so per-IP caps are approximate under Cloudflare's multi-isolate fan-out; the security model already flags moving to Cloudflare WAF/Turnstile or a Durable Object counter if abuse becomes real. The per-email cap here is exact because it reads D1. Record this as the durable backstop.

### 3.3 Single-use, short-TTL request token (distinct from the 30-day session)

Reuse `portalAccessTokens` + `hashToken` + `randomBytes(32)`. Distinguish the two token lifecycles with a new `kind` column:

- `kind = "magic_request"`: TTL = `PORTAL_MAGIC_LINK_TTL_MINUTES` (default **20 min**), single-use, **does not** set any session cookie by existing. Carries `projectId` + `clientId` (satisfies the existing canon guard requiring the client to belong to the project — migration 0069, trg_portal_access_tokens_project_canon_*).
- `kind = "session"`: the existing 30-day token behavior (default for all current rows).

**Schema change (`src/db/schema.ts` + `migrations/0084_portal_magic_request_tokens.sql`):**

```sql
ALTER TABLE portal_access_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'session';
ALTER TABLE portal_access_tokens ADD COLUMN consumed_at TEXT;
CREATE INDEX idx_portal_tokens_kind_client
  ON portal_access_tokens (client_id, kind, created_at);   -- per-email rate query
```

Drizzle:

```ts
kind: text("kind").notNull().default("session"),   // "session" | "magic_request"
consumedAt: text("consumed_at"),
```

**[N5] Canon-guard triggers must be DROPped and re-CREATEd — `CREATE TRIGGER IF NOT EXISTS` silently no-ops when a trigger of the same name already exists (from migration 0069), and SQLite cannot `ALTER` a trigger.** So the new migration must, for the two portal-token canon triggers, `DROP TRIGGER` then recreate them with the new columns folded in:

```sql
-- 0084: recreate the 0069 portal-token detail-text canon guards to cover consumed_at,
-- and add a kind-domain guard. DROP first (IF NOT EXISTS on CREATE would no-op otherwise).
DROP TRIGGER IF EXISTS trg_portal_access_tokens_detail_text_canon_insert;
DROP TRIGGER IF EXISTS trg_portal_access_tokens_detail_text_canon_update;

CREATE TRIGGER trg_portal_access_tokens_detail_text_canon_insert
BEFORE INSERT ON portal_access_tokens
FOR EACH ROW
WHEN (NEW.label       IS NOT NULL AND (trim(NEW.label)       = '' OR NEW.label       <> trim(NEW.label)))
  OR (NEW.revoked_at  IS NOT NULL AND (trim(NEW.revoked_at)  = '' OR NEW.revoked_at  <> trim(NEW.revoked_at)))
  OR (NEW.last_used_at IS NOT NULL AND (trim(NEW.last_used_at) = '' OR NEW.last_used_at <> trim(NEW.last_used_at)))
  OR (NEW.last_used_ip IS NOT NULL AND (trim(NEW.last_used_ip) = '' OR NEW.last_used_ip <> trim(NEW.last_used_ip)))
  OR (NEW.consumed_at IS NOT NULL AND (trim(NEW.consumed_at) = '' OR NEW.consumed_at <> trim(NEW.consumed_at)))   -- NEW
  OR NEW.kind IS NULL OR NEW.kind NOT IN ('session','magic_request')                                             -- NEW
BEGIN
  SELECT RAISE(ABORT, 'portal access token detail text must be null or trimmed non-empty text and kind must be canonical');
END;

-- The UPDATE trigger must add consumed_at (and kind) to BOTH the `UPDATE OF` column
-- list AND the WHEN clause — consumePortalMagicLink writes consumed_at, so the guard
-- must fire on that column or it will never validate it.
DROP TRIGGER IF EXISTS trg_portal_access_tokens_detail_text_canon_update;
CREATE TRIGGER trg_portal_access_tokens_detail_text_canon_update
BEFORE UPDATE OF label, revoked_at, last_used_at, last_used_ip, consumed_at, kind ON portal_access_tokens
FOR EACH ROW
WHEN ( ... same predicate as insert, including consumed_at + kind ... )
BEGIN
  SELECT RAISE(ABORT, 'portal access token detail text must be null or trimmed non-empty text and kind must be canonical');
END;
```

The identity/project canon triggers (0069) are unchanged — magic-request rows still carry a valid `token_hash`, `expires_at`, and a `(project_id, client_id)` that satisfies the participant guard. The `studio-canon` test suite must be extended to assert: a `magic_request` insert with a valid client/project passes; an invalid `kind` aborts; a blank `consumed_at` aborts on both insert and update.

**Mint (`requestPortalMagicLink`, per project):**

```ts
const token = randomBytes(32).toString("base64url");
await db.insert(portalAccessTokens).values({
  id: crypto.randomUUID(),
  projectId, clientId,
  tokenHash: hashToken(token),
  kind: "magic_request",
  label: "Self-service magic link",
  expiresAt: new Date(Date.now() + TTL_MIN * 60_000).toISOString(),
  createdAt: new Date().toISOString(),
});
// URL: `${portalBaseUrl()}/portal/login/verify/${token}`
```

**Consume (`consumePortalMagicLink(token)` called by `verify/[token]/route.ts`):**

```ts
export async function consumePortalMagicLink(token: string) {
  const hashed = hashToken(token);
  const row = await db.query.portalAccessTokens.findFirst({
    where: and(eq(portalAccessTokens.tokenHash, hashed),
               eq(portalAccessTokens.kind, "magic_request")),
  });
  if (!row || row.revokedAt || row.consumedAt || new Date(row.expiresAt) < new Date()) {
    return { ok: false as const, reason: "invalid" };
  }
  // atomic single-use: only the first UPDATE that flips consumed_at wins
  const claimed = await db.update(portalAccessTokens)
    .set({ consumedAt: new Date().toISOString() })
    .where(and(eq(portalAccessTokens.id, row.id), isNull(portalAccessTokens.consumedAt)))
    .returning({ id: portalAccessTokens.id });
  if (!claimed.length) return { ok: false as const, reason: "invalid" };

  // establish the EXISTING 30-day session: mint a fresh kind:"session" token and
  // set cookies exactly as authenticatePortalToken does.
  const session = await createPortalLink({
    projectId: row.projectId, clientId: row.clientId,
    label: "Client portal session (magic link)",
    actorType: "client",
  });
  await establishPortalSessionCookies(session.tokenId, row.projectId); // shared with authenticatePortalToken
  await logActivity({ projectId: row.projectId, clientId: row.clientId,
    action: "portal.magic_link.consumed", actorType: "client", actorName: "Client" });
  return { ok: true as const };
}
```

Refactor: extract the cookie-setting block from `authenticatePortalToken` into `establishPortalSessionCookies(tokenId, projectId)` and call it from both. Do **not** duplicate cookie options.

**Defense-in-depth `kind` filtering (both read paths):** a `magic_request` token must never grant a session by any route other than `consumePortalMagicLink`.
- `authenticatePortalToken` (`/p/[token]`): add `eq(portalAccessTokens.kind, "session")` to its lookup `where`, so a leaked magic-request token cannot be redeemed as a direct portal link.
- **[N4]** `requirePortalProject` (every portal page load): add `eq(portalAccessTokens.kind, "session")` to its token lookup as well. The session cookie only ever holds a `kind:"session"` `tokenId`, but pinning the kind here means even a mis-set cookie pointing at a `magic_request` row cannot resolve a session.

**Route `src/app/portal/login/verify/[token]/route.ts`:**

```ts
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await consumePortalMagicLink(token);
  redirect(r.ok ? "/portal" : "/portal/login?error=expired");
}
```

Reuse/expiry/double-click → `{ ok:false }` → clean redirect to `/portal/login?error=expired` with the copy "That link has expired or was already used — request a new one." No stack traces, no differentiation between expired vs consumed vs unknown.

**[N2] Mail-scanner pre-fetch (recommended, low effort).** Corporate mail security (Outlook SafeLinks, Proofpoint, Mimecast) and some clients **GET the link automatically** before the human clicks — a naive single-use GET-consume would burn the token, and the real click then lands on the "already used" page. The proxy already 204s known prefetch signals (`purpose: prefetch`, `sec-purpose`, `next-router-prefetch`) but scanners often send a plain GET. Mitigation — **split render from consume:**
- `GET /portal/login/verify/[token]` **does not consume.** It validates the token is well-formed/live and renders a tiny interstitial ("Continue to your portal") whose button issues `POST /portal/login/verify/[token]`. Scanners fetch the GET (harmless, no consume); the human's click POSTs and consumes.
- `POST` runs `consumePortalMagicLink` (the atomic single-use claim) and redirects to `/portal`.
This keeps single-use semantics while surviving link scanners. Trade-off: one extra click. If telemetry later shows scanners are a non-issue for this audience, the GET-consume form can be restored. Either way the atomic `consumed_at` claim (§3.3) is the correctness backstop; the split is a UX/deliverability safeguard, not a security one.

### 3.4 Crypto reuse + bot/abuse

- **No new crypto.** Token = `randomBytes(32).toString("base64url")` (existing), hashed with `hashToken` (SHA-256, existing). No HMAC/signing secret is introduced for the magic token — deliberately the **random-token-hashed-at-rest** model, not the HMAC-context model used by questionnaire links. (See §6 for why no `SCHEDULER_LINK_SECRET`.)
- **Bot/abuse:** per-IP + per-email caps are the baseline. **Turnstile is the documented future option** (already flagged in security-model.md "Move front-door rate limiting to Cloudflare WAF/Turnstile"): a Turnstile widget on `/portal/login` + token verification in the POST handler would be a drop-in later; the endpoint is designed so adding a `cf-turnstile-response` check is additive and does not change the token model. Note it, don't build it.

---

## 4. Phase-6 follow-ups folded in

### 4.1 (a) `/portal/proposals/:id` proxy login-wall

**Bug.** `isPortalPublicPath` (`_worker.js:159`) matches only `pathname === "/portal"` (exact) and `/p/`. A signed-in client clicking a proposal link inside the portal hits `/portal/proposals/:id`, which is **not** public → falls through to `!isStudioPublicPath` → `verifyAdminSession` fails → **303 to `/admin/login`** (Google admin sign-in). The origin route `src/app/portal/proposals/[proposalId]/route.ts` already self-protects via `requirePortalProject()` and 303s to `/portal` if no portal session — so the proxy gate is both wrong and redundant for the whole `/portal` subtree.

**Fix.** Broaden `isPortalPublicPath` to the entire `/portal` subtree (every route under `/portal` is client-facing and self-protected by the portal session cookie or public by design):

```js
export function isPortalPublicPath(pathname) {
  return pathname === "/portal" || pathname.startsWith("/portal/") || pathname.startsWith("/p/");
}
```

This is a fix to **classifier (1)** only (the proxy admin-Google-gate) and simultaneously unblocks `/portal/proposals/:id`, `/portal/login`, and `/portal/login/verify/*`. It must be applied in lockstep with the `adminProofRequired` fix (classifier 2, §1.4/B1) — both currently exempt only `/portal` exact + `/portal/proposals/`, so both need the subtree.

**Do NOT** mirror this into `src/lib/origin-guard.ts` (classifier 3). `/portal` is deliberately **not** in `PUBLIC_PAGE_PREFIXES` today — portal pages are reachable only through the proxy (which injects `x-reese-origin-secret`), and that origin-secret gate is exactly what keeps the per-IP-limited request endpoint from being bypassed (§1.4/B2). Leave origin-guard untouched.

**Guard against over-exposure:** confirm no admin-only route is namespaced under `/portal` (audit: today only `/portal`, `/portal/proposals/[proposalId]` exist; both client-facing). Document that `/portal/*` is a client-facing namespace so future routes there are consciously public + self-protected.

**Test** (`pages-proxy/_worker.test.*` and/or `src/middleware.test.ts`):

- `isPortalPublicPath("/portal/proposals/abc")` → `true`.
- A request to `/portal/proposals/abc` with **no** admin session is **not** redirected to `/admin/login` (proxy passes through; origin decides).
- `/portal/login` and `/portal/login/verify/tok` → `true`; not admin-gated.
- Regression: `/admin/anything` still 303 → `/admin/login`.

### 4.2 (b) `verifyAdminSession` non-constant-time compare

**Bug.** `_worker.js:79`: `if (signature !== expected) return false;` — the HMAC signature comparison is a plain `!==`, non-constant-time, inconsistent with the already-fixed agent bearer compare (`src/lib/agent-api.ts` `tokensMatch` → `timingSafeEqual`) and the questionnaire-link verify (`timingSafeEqual`).

**Fix.** The Worker runtime has no `node:crypto.timingSafeEqual`. Add a constant-time equal over the two base64url signature strings (equal length by construction — both are SHA-256 HMAC base64url):

```js
function constantTimeEqual(a, b) {
  const ab = textEncoder.encode(a), bb = textEncoder.encode(b);
  if (ab.length !== bb.length) return false;    // length is not secret (fixed-size HMAC)
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
// verifyAdminSession: if (!constantTimeEqual(signature, expected)) return false;
```

Byte-wise XOR accumulation is the standard WebCrypto-context constant-time compare (mirrors `tokensMatch`'s intent). Apply the same helper to any other `!==` secret compare in the worker if present.

**Test:** unit-test `constantTimeEqual` (equal strings → true; single-bit-flip → false; different length → false) and a `verifyAdminSession` test asserting a tampered signature is rejected. This aligns with the L9/agent-api constant-time fix noted in security-model.md.

---

## 5. Email content, activity logging, what to store

### 5.1 Email (`src/lib/email.ts` → `sendPortalMagicLinkEmail`)

Reuse the existing private `sendResendEmail` (RESEND_API_KEY, `RESEND_FROM_EMAIL` fallback `"The Reeses <hello@bythereeses.com>"`). Export a new function; keep plaintext `text` body consistent with the file's current style (no HTML template needed for v1; `sendResendEmail` sends `text`).

```ts
export async function sendPortalMagicLinkEmail(input: {
  to: string;
  clientFirstName: string | null;
  links: Array<{ projectName: string; url: string }>;   // 1..N active projects
  ttlMinutes: number;
}): Promise<boolean>;
```

Body:

```
Hi {firstName or "there"},

Here's your secure sign-in link for The Reeses client portal.

  {for each project}  View {projectName}: {url}

This link expires in {ttlMinutes} minutes and can be used once. If you didn't
request it, you can ignore this email — no one can access your portal without it.

The Reeses Studio
```

Subject: `Your Reese Photography portal sign-in link`. One email per request regardless of project count. Send is fire-and-forget relative to the HTTP response (§3.1).

### 5.2 Activity logging (`activity_logs` via `logActivity`)

New actions (extend the existing portal action vocabulary — security-model.md lists portal login/view/revoke/logout as logged):

| Action | When | actorType | metadata |
| --- | --- | --- | --- |
| `portal.magic_link.requested` | a request produced ≥1 token (match) | `client` | `{ projectId, tokenId, expiresAt }` per token |
| `portal.magic_link.consumed` | token redeemed → session established | `client` | `{ requestTokenId, sessionTokenId }` |
| `portal.magic_link.rejected` | consume of expired/used/unknown token | `system` | `{ reason }` (no token plaintext) |

**No-match requests:** do **not** write a project-scoped activity row (there is no project/client). Optionally emit a metrics-only counter, or a single non-project `activity_logs` row with `action: "portal.magic_link.requested_no_match"` keyed by IP + a **salted hash of the email** (never raw email) so abuse is auditable without storing a queryable email→exists oracle. Ensure nothing about match/no-match is exposed to the client.

### 5.3 What is stored

- `portalAccessTokens` magic-request row: hash only (never plaintext token), `projectId`, `clientId`, `kind`, `expiresAt`, `consumedAt`, `lastUsedIp` (on consume, reuse existing field). Plaintext token exists only in the emailed URL.
- Session row on consume: existing `kind:"session"` 30-day row (unchanged shape).
- Activity logs as above. No new PII beyond what `clients` already holds.

---

## 6. Config / secrets

**No new signing secret.** The magic token is opaque random + SHA-256-at-rest, so it needs no HMAC key — unlike questionnaire links (`SCHEDULER_LINK_SECRET || AUTH_SECRET`, HMAC). Reusing the random-token-hashed model keeps parity with the existing portal tokens and avoids adding a secret to rotate. **Decision: do not introduce a dedicated magic-link secret.**

New env vars (all with safe defaults; secrets unchanged):

| Var | Default | Purpose |
| --- | --- | --- |
| `PORTAL_MAGIC_LINK_ENABLED` | unset/`0` (OFF) | Feature flag. When off: `/portal/login` shows fallback copy, POST returns uniform 200 no-op. |
| `PORTAL_MAGIC_LINK_TTL_MINUTES` | `20` | Request-token TTL. |
| `PORTAL_MAGIC_LINK_PER_EMAIL_MAX` | `3` | Request-batches (not raw tokens — N3) per client per 15 min (D1 cap, enforced on the deferred task). |
| `PORTAL_MAGIC_LINK_MAX_PROJECTS` | `5` | Max projects listed / tokens minted per request. |
| `requestLink` proxy limit | `5 / 900s` | Per-IP (in `_worker.js` `RATE_LIMITS`). |

Reused, unchanged: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `PORTAL_BASE_URL` (→ magic-link URLs), `ORIGIN_PROXY_SECRET`, `ADMIN_SESSION_SECRET`.

---

## 7. Test plan (per file)

| File | Tests |
| --- | --- |
| `src/lib/portal.ts` | `resolveActiveProjectsForEmail`: canonical-email match, active-only filter, multi-project, no-match → `[]`. `requestPortalMagicLink`: mints one token per active project; per-email cap returns noop past N; flag-off noop; email-send is not awaited before return. `consumePortalMagicLink`: valid → session cookies set + `kind:"session"` row created; expired/consumed/unknown → `{ok:false}`; **double-consume race → exactly one success** (atomic `consumed_at` claim); a `magic_request` token cannot be redeemed via `authenticatePortalToken`. `establishPortalSessionCookies` shared-path parity. |
| `src/app/api/portal/request-link/route.ts` | match vs no-match → **byte-identical** response; malformed email → same; flag-off → same; JSON vs form negotiation. (Timing asserted structurally: assert send promise not awaited; assert no branch-specific early return.) |
| `src/app/portal/login/verify/[token]/route.ts` | **GET** (no consume): live token → renders continue interstitial; malformed/expired → error page; token NOT consumed (assert `consumed_at` still null after GET) [N2]. **POST** (consume): valid → 303 `/portal` + cookies; invalid/reuse → 303 `/portal/login?error=expired`. |
| `src/app/portal/login/page.tsx` | renders form when flag on; fallback when off; `?sent=1` confirmation; `?error` copy. |
| `src/lib/email.ts` | `sendPortalMagicLinkEmail`: single vs multi-project body; subject; returns `false` when `RESEND_API_KEY` unset (no throw). |
| `src/lib/admin-proxy-auth.ts` (`admin-surface-classification.test.ts`) | **[B1]** `adminProofRequired` → `false` for `/portal/login`, `/portal/login/verify/x`, `/api/portal/request-link`, `/portal/proposals/x`, `/portal`; `true` still for `/admin/*` and other genuine admin surfaces; drift assertions vs proxy public-path predicates stay in sync. |
| `src/lib/origin-guard.ts` (`origin-guard.test.ts`) | **[B2] negative test:** a direct `*.workers.dev` request (no `x-reese-origin-secret`) to `/api/portal/request-link` and `/portal/login/verify/x` is **404'd** (stays gated, not bypassed). `/p/x` still bypasses (unchanged). |
| `pages-proxy/_worker.js` tests | `isPortalPublicPath` subtree matches (4.1); `/portal/proposals/x` **not** → `/admin/login`; `rateLimitKind` → `requestLink` for POST `/api/portal/request-link`, `tokenAccess` for verify; 429 after cap; **request to `*.workers.dev` still goes through proxy so the limiter applies** (B2). `constantTimeEqual` unit + `verifyAdminSession` tamper rejection (4.2). |
| `src/middleware.test.ts` | regression: broadened portal public path doesn't expose admin surfaces; flag-off surface behaves as pre-6.5. |
| migration `0084` | canon-guard: `kind` constrained to allowed set; `consumed_at` null-or-trimmed; existing portal-token insert path still passes (session default). |

Enumeration/timing is verified **structurally** (identical response bytes, no awaited send, no branch-specific early exit) rather than by wall-clock assertions, which are flaky in CI.

---

## 8. Rollout / rollback

- **Feature-flagged OFF by default** (`PORTAL_MAGIC_LINK_ENABLED`), matching the Phase 6 pattern (`CSP_MODE`, admin-proof flag default off in `middleware.test.ts`). With the flag off, the only *always-on* changes are the two Phase-6 follow-ups (§4), which are strict security improvements and safe to ship independently.
- **Sequencing:** land §4 (proxy fixes) first as a standalone, low-risk change (they are bug/hardening fixes with no flag). Then land the magic-link surface behind the flag. Enable the flag in prod only after a smoke on the deployed studio host.
- **Rollback:** set `PORTAL_MAGIC_LINK_ENABLED=0` — disables the request/verify flow instantly with no deploy. The additive schema columns (`kind` default `session`, nullable `consumed_at`) are backward-compatible and need no down-migration; existing `/p/` + admin/agent minting is untouched. §4 changes roll back via redeploying the prior `_worker.js` if ever needed (independent of the flag).
- **Smoke (mirror `docs/studio-agent-access.md` smoke + ops checklist):** (1) request link for a known test client → email arrives (confirms `waitUntil` fires — N1); (2) click → lands in `/portal` with the right project; (3) reuse link → clean expired page; (4) request for unknown email → identical confirmation, no email; (5) `/portal/proposals/:id` while signed in → opens (no `/admin/login` bounce); (6) admin route still bounces to Google login; (7) **with `ADMIN_PROOF_ENFORCE=1`**, the whole request/verify flow still works (confirms the B1 `adminProofRequired` exemption); (8) direct `*.workers.dev/api/portal/request-link` POST → 404 (confirms B2 gating).

---

## 9. Task breakdown (ordered, with effort / risk)

| # | Task | Files | Effort | Risk |
| --- | --- | --- | --- | --- |
| 1 | **Portal-subtree classifiers §4a + B1** — broaden `isPortalPublicPath` (proxy admin-gate) **and** `adminProofRequired` (`admin-proxy-auth.ts`) to the `/portal` subtree + exempt `/api/portal/request-link`; update `admin-surface-classification.test.ts` drift test. **Leave origin-guard untouched (B2).** | `_worker.js`, `admin-proxy-auth.ts`, tests | S | Med (two classifiers must move in lockstep; missing the admin-proof one 404s the flow under enforce) |
| 2 | **Proxy §4b** — `constantTimeEqual` + `verifyAdminSession` fix; tests | `_worker.js`, tests | S | Low (behavior-preserving; pure timing fix) |
| 3 | **Schema/migration** — `kind` + `consumed_at`, index, **DROP+CREATE 0069 detail-text triggers** to cover `consumed_at` + `kind` (N5) | `schema.ts`, `migrations/0084_*`, canon test | S | Med (SQLite triggers can't be altered/re-created via `IF NOT EXISTS`; must DROP first or the guard silently no-ops) |
| 4 | **portal.ts core** — `resolveActiveProjectsForEmail`, `requestPortalMagicLink`, `consumePortalMagicLink`, extract `establishPortalSessionCookies`, `kind:"session"` filter on `authenticatePortalToken` | `portal.ts`, tests | M | Med (session-establishment + single-use atomicity; must not regress `/p/`) |
| 5 | **Email** — `sendPortalMagicLinkEmail` | `email.ts`, tests | S | Low |
| 6 | **Endpoints/pages** — `POST /api/portal/request-link` (uniform response; ALL match-work deferred via `waitUntil` — N1/B3), `GET /portal/login`, `GET`(render)/`POST`(consume) `/portal/login/verify/[token]` (N2), flag gating | 3 new files, tests | M | High (enumeration/timing crux §3.1; `waitUntil` mandatory or emails silently drop) |
| 7 | **Rate limits** — `requestLink` kind + `rateLimitKind` ordering (proxy) + per-email D1 cap (in task 4) | `_worker.js`, tests | S | Med (guard ordering vs broadened `/portal` `tokenAccess` branch) |
| 8 | **Config + docs** — env defaults, update `security-model.md` (new logged actions, magic-link model), smoke in ops checklist | docs, env | S | Low |
| 9 | **Verify + Fable review + flag-on rollout** | — | S | Med (prod enable; gated by Tyler approval) |

**Critical-path / highest-attention items:** task 6 (no-enumeration + timing-flat response with ALL match-work on the `waitUntil` task — B3/N1; a missing `waitUntil` silently drops every email), task 1 (three classifiers must agree — proxy admin-gate + `adminProofRequired` moved to subtree, origin-guard deliberately NOT — B1/B2), task 4 (atomic single-use + `kind` filtering on both `authenticatePortalToken` and `requirePortalProject` — N4), task 3 (DROP+CREATE canon triggers — N5). Tasks 1–2 are shippable immediately as independent hardening.

---

## 10. Review changelog (Fable APPROVE-WITH-CHANGES, 2026-07-05)

- **B1 (blocking, fixed):** added `src/lib/admin-proxy-auth.ts` `adminProofRequired` + its drift test to the change set — the `/portal` subtree and `/api/portal/request-link` must be exempted there too, or the flow 404s under `ADMIN_PROOF_ENFORCE=1`. See §1.4(2), §1.1.
- **B2 (blocking, fixed):** `src/lib/origin-guard.ts` is now explicitly **left unchanged** — adding the request endpoint to the origin bypass would let a direct `*.workers.dev` POST skip the only per-IP limiter → email-bombing. See §1.4(3), §4.1.
- **B3 (blocking, fixed):** the per-email rate check moved from pre-response to the deferred `waitUntil` task (it needs a `clientId` D1 lookup; pre-response it recreated the timing oracle). Pre-response work is now only `formData` parse + firing the deferred task. See §1.3, §3.1, §3.2.
- **N1 (fixed):** deferred email send must use `getCloudflareContext().ctx.waitUntil(...)` — unawaited promises are canceled on Workers/OpenNext. See §1.3.
- **N4 (fixed):** `eq(kind,"session")` added to `requirePortalProject` as well as `authenticatePortalToken`. See §3.3.
- **N5 (fixed):** the 0084 migration DROPs then re-CREATEs the 0069 detail-text triggers with `consumed_at` + `kind` in both `UPDATE OF` and the `WHEN` clause. See §3.3.
- **N2 (folded in):** GET renders a continue interstitial, POST consumes — survives mail-scanner pre-fetch. See §3.3 verify route.
- **N3 (folded in):** per-email cap counts request-batches, not raw tokens, so a multi-project client isn't self-throttled. See §3.2.
