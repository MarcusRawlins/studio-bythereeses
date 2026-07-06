# Phase 14: Two-way per-project email — Design Spec

Status: **design only, not built.** Both new capabilities ship behind OFF flags. No implementation code in this document.

Owner approval doctrine (unchanged): **agents draft, Tyler sends.** Nothing in this phase auto-sends a client-facing email or lets inbound email mutate a canonical record.

## 0. Goal and the exact gap this closes

Today email is a **second-class, one-way** channel on the project thread; SMS is already two-way. Grounded in the code:

- **Outbound project email is LOG-ONLY.** The "Mark sent" button in `src/app/projects/[id]/page.tsx` (lines 1140-1156) just POSTs `status:"sent"` back through `createProjectCommunicationFromForm` → `updateProjectCommunication` — it flips a DB status and never calls Resend. (The comment there says as much: *"'sent' only ever meant 'logged as sent', not 'we texted them'"*.) SMS by contrast has a real gated send (`sendApprovedProjectSms` → `sendProjectSms`) surfaced by a dedicated "Send SMS" affordance (page.tsx lines 1159-1188).
- **Inbound email is inquiry-intake ONLY.** `src/lib/inbound-inquiry.ts` (Phase 8a) always creates a NEW `inbound_inquiries` triage row and, on approval, a NEW canonical project. There is no path that attaches an inbound client reply to an **existing** project's `project_communications` thread. (The 8a spec itself lists *"Inbound email capture into an existing project thread"* as explicitly out of scope — this phase is that slice.)
- The one place email *is* sent from the CRM today is `approveInquiryReply` in `inbound-inquiry.ts` (lines 691-730), a self-contained one-shot Resend call on inquiry approval — not a project-thread send.

Phase 14 adds three things, each mirroring a proven existing pattern:

1. **Outbound send from the project thread** — `sendApprovedProjectEmail`, mirroring `sendApprovedProjectSms` (content-hash approval, suppression honored, fail-closed key, typed refusals, admin-only route, OFF flag).
2. **Inbound routing into the EXISTING project thread** — a Cloudflare Email Routing → Worker → CRM-endpoint pipeline (identical shape to 8a) that attaches a client reply to the right project via an **opaque signed Reply-To token**, never by trusting spoofable headers. This is the make-or-break; §3 has the most rigor.
3. **Unified email + SMS + note thread** in the project Communications section, with an email send affordance mirroring the SMS UX.

### In scope
- `sendApprovedProjectEmail` + admin-only `/api/projects/[id]/communications/send-email` route.
- Reply-To token (mint on outbound, verify on inbound), stateless keyed derivation.
- Inbound project-email Worker + `/api/inbound/project-email` endpoint (reuses 8a parsers/sanitizers).
- Append inbound reply as a `project_communications` row (direction `inbound`, channel `email`), dedupe on Message-ID.
- Agent `studio_draft_email` tool (draft-only) + closing the agent email-send authority gap.
- Unified thread UI + email send affordance.
- Migration 0092 (additive, 3-place mirror).
- Flags, rollout, Tyler provider-config steps.

### Out of scope
- HTML email composition / rich templates (plain text only, like every existing sender in `email.ts`).
- Inbound attachment ingestion (metadata-logged only, reusing 8a's `extractAttachmentMetadata`; never parsed/opened/stored to galleries).
- Rendering inbound HTML (server-side text projection only — reuse `stripHtmlToText`).
- Multi-inbox / per-brand routing beyond the single reply subdomain.
- Auto-reply of any kind (no code composes an automatic response).
- Changing the 8a inquiry path (it stays untouched; this is a separate worker + endpoint to avoid regressing the proven pipeline).

---

## 1. Outbound send — `sendApprovedProjectEmail`

Mirror `sendApprovedProjectSms` (`src/lib/project-communications.ts` lines 364-442) exactly; the only structural differences are (a) email has a subject that is also an injection surface, (b) suppression is by email not phone, (c) transport is Resend not Twilio.

### 1.1 Length caps
Add a shared email body cap alongside `SMS_BODY_MAX_LENGTH`, enforced in `createProjectCommunication`/`updateProjectCommunication` (so *every* caller — form, agent, MCP — is bound, exactly like `assertSmsBodyLength`):

- `EMAIL_BODY_MAX_LENGTH = 50_000` (align with `MAX_BODY_TEXT_LENGTH` in `inbound-inquiry.ts` so an outbound body and a stored inbound body share one ceiling).
- Subject reuses `MAX_SUBJECT_LENGTH = 500` and is CRLF-sanitized at send time via the existing `stripReplySubjectForSend` (exported from `inbound-inquiry.ts`, lines 435-447 — folds CR/LF/NEL/LS/PS, strips control chars, **throws** if a newline survives). A subject becomes a Resend header, so this is mandatory header-injection defense.

Add `assertEmailBodyLength(channel, body)` mirroring `assertSmsBodyLength`, called from the same two spots.

### 1.2 Content-hash approval (mirror B1a, bind subject AND body AND recipient)
SMS hashes the body only (`sha256Hex(communication.body)`), because SMS has no subject **and** its recipient derives from the consented client record via `clientId` (not an agent-updatable field), so a post-review recipient swap is structurally impossible for SMS. Email is different on **both** axes: it has a subject that is an injection surface, and its recipient is the agent-updatable `recipientEmail` column. A prompt-injected agent can call `studio_update_communication` setting ONLY `recipientEmail` (verified: `UpdateProjectCommunicationInput` includes `recipientEmail`; the `studio_update_communication` patch loop forwards it — `studio-mcp.ts:2898; project-communications.ts:255`) AFTER Tyler reviews — status stays `draft`, subject/body unchanged, so a subject+body-only hash still matches — and step 6 below resolves the recipient from the row, delivering the approved proposal/scheduling links and client PII to an attacker address while the row reads "sent". So the approval binding must cover subject, body, **and the resolved recipient**. Define (unambiguous per-component encoding so a newline-bearing subject can never collide with a differently-split subject/body — Finding LOW 3):

```
emailApprovalHash(subject, body, recipient) =
  sha256Hex( sha256Hex(subject ?? "") + sha256Hex(body ?? "") + sha256Hex(recipient ?? "") )
```

Export it from `project-communications.ts` next to `sha256Hex` (already exported and already imported by page.tsx line 10). The page/affordance computes the hash over the recipient it **displays**; the send path RE-RESOLVES the recipient first (§1.3 step 5), then recomputes `emailApprovalHash(stored.subject, stored.body, resolvedRecipient)` and REFUSES (no Resend call) on mismatch — closing both the draft-swap TOCTOU the SMS path closes AND the recipient-redirect TOCTOU that SMS never had to defend. A post-review `recipientEmail` swap changes the resolved recipient → the hash no longer matches → `hash_mismatch`, zero Resend calls.

Subject newline hygiene: strip CR/LF/NEL/LS/PS from the subject at **create/update time** for email rows (not only at send), so the stored subject is already single-line before it is ever hashed or displayed — `cleanText` only trims, it does not fold newlines. Send-time `stripReplySubjectForSend` (§1.3, §1.1) remains as defense-in-depth.

### 1.3 The function
Signature mirrors `SendApprovedSmsResult`:

```
sendApprovedProjectEmail(input: {
  projectId: string; communicationId: string; approvedBodyHash: string; actorName?: string;
}): Promise<SendApprovedEmailResult>
```

Refusal reasons (typed union, mirror the SMS set): `not_found | not_email | not_draft | too_long | hash_mismatch | no_recipient | suppressed | not_configured | send_failed | flag_off`.

Ordered gate (each step refuses with NO Resend call, mirroring lines 370-413). **The recipient is resolved BEFORE the hash check** so the hash can bind it (§1.2, Finding MEDIUM 1):
1. Load comm by `(id, projectId)`; missing → `not_found`.
2. `channel !== "email"` → `not_email`.
3. `status !== "draft" || direction !== "outbound"` → `not_draft` (refuses a re-submit of an already-sent row = no double-send, and an inbound row can never be "sent back").
4. `(body ?? "").length > EMAIL_BODY_MAX_LENGTH` → `too_long` (belt-and-braces for legacy drafts, mirror line 389).
5. **Resolve recipient FIRST:** `recipientEmail` on the row, else the project primary participant's email (reuse `resolveRecipient`). None valid via `normalizeEmail` → `no_recipient`. This must happen before the hash check because the hash binds the resolved recipient.
6. Recompute `emailApprovalHash(stored.subject, stored.body, resolvedRecipient)`; `!== approvedBodyHash` → `hash_mismatch` + `logActivity("project.communication.email_send_refused", reason:"hash_mismatch")` (mirror lines 400-413). A post-review swap of subject, body, **or `recipientEmail`** lands here → refused, zero Resend calls.
7. `isEmailSuppressed(resolvedRecipient)` (from `email.ts`) → `suppressed`. **Suppression wins** — the same discipline as `sendSequenceEmail` (email.ts line 107) and the SMS suppression-wins rule.
8. Flag: `emailSendingEnabled()` false → `flag_off` (dark no-op, draft stays, no false success). See §6.
9. Fail-closed key: if `RESEND_API_KEY` unset, the low-level send returns not-delivered → `not_configured`, draft stays. Never mark sent.
10. Transport via the **reused** `email.ts` Resend path (§1.5). Classify the outcome exactly like `sendSequenceEmail`:
    - delivered → update row `status:"sent"`, `sentAt`, `providerMessageId` = Resend message id (§1.5), `deliveryStatus:"sent"`; return `{ ok:true }`.
    - definitive 4xx (`rejected`) → `send_failed`, draft stays.
    - 5xx / network / thrown (`unknown`) → `send_failed`, draft stays (never a false "sent" on an ambiguous outcome — under-send only, matching the sequence ledger discipline).

CRLF-strip the subject with `stripReplySubjectForSend` immediately before the Resend call (defense in depth even though the compose textarea shouldn't allow newlines in a single-line subject input).

`logActivity("project.communication.email_sent", { communicationId, recipient, providerMessageId, delivered })` on success (mirror `sms_sent`, masking nothing sensitive — email is not a secret, but do not log the body).

### 1.4 Form wrapper + admin-only route
- `sendApprovedProjectEmailFromForm(formData)` mirroring `sendApprovedProjectSmsFromForm` (reads `projectId`, `communicationId`, `approvedBodyHash` from the trusted form; note projectId is sourced from the **URL path param** in the route, not the body, matching send-sms).
- New route `src/app/api/projects/[id]/communications/send-email/route.ts` — a byte-for-byte structural copy of `send-sms/route.ts`:
  - POST-only; `guardDirectWorkerApiRequest(request)` first (blocks direct `*.workers.dev` without the stamped origin secret);
  - reads `communicationId` + `approvedBodyHash` from `formData`; projectId from `params`;
  - PRG: on `!ok` → `redirectToProject(id, { emailError: result.reason })`; on ok → `{ saved: "email_sent" }`; on throw → log server-side, `{ emailError: "send_failed" }` (never put a raw error/PII in the URL);
  - `revalidateProject(id)`.
  - **NOT** listed in `isStudioPublicPath` / `isPublicOriginBypassApiPath` / any `adminProofRequired` exemption → it falls through to the default "genuine admin surface" branch (Google admin session + admin proof under `ADMIN_PROOF_ENFORCE=1`). **NOT** registered as an MCP/agent tool. This makes it structurally identical to send-sms: admin-only, not agent-reachable.

### 1.5 Reuse the Resend integration (do NOT reimplement)
Two small, backward-compatible additions to `src/lib/email.ts`'s `resendRequest` (lines 32-57):

1. Accept an optional `replyTo?: string` and forward it as Resend's `reply_to` field. Currently the JSON body sets only `from/to/subject/text/headers`; add `...(input.replyTo ? { reply_to: input.replyTo } : {})`. This is how two-way is wired (§2).
2. Capture the Resend message id: on `response.ok`, read `id` from the JSON body and return `{ delivered, status, providerMessageId }`. Existing callers ignore the new field (no behavior change to booking/sequence/magic-link mail).

Add a thin `sendProjectEmail(input: { to; subject; text; replyTo? })` in `email.ts` that calls `resendRequest` and returns `{ delivered, status, providerMessageId }` — the single Resend entry the project-thread send uses. The suppression gate stays in `sendApprovedProjectEmail` (like SMS keeps consent in the lib), so `sendProjectEmail` is the transport only. `sendApprovedProjectEmail` computes `replyTo = mintProjectReplyToken(projectId)` and passes it through; when `REPLY_TOKEN_SECRET` is unset `mintProjectReplyToken` returns `null` → `replyTo` is `undefined` → `resendRequest` omits `reply_to` entirely (never an empty-tag bouncing address, §2.2 fail-closed mint). Two-way stays dark but outbound still sends.

**No List-Unsubscribe on project-thread email.** RFC 8058 one-click unsubscribe (email.ts lines 109-118) is for *automated* sequence mail; a 1:1 human reply on a live project is transactional relationship mail and must not carry an "unsubscribe from your own wedding" link. We still **honor** the suppression list on send (§1.3 step 7) — a client who globally suppressed is not emailed; Tyler sees the `suppressed` refusal and can reach them another way.

---

## 2. Inbound routing into the project thread (the reply-token design)

### 2.1 Pipeline (mirror 8a's transport exactly)
```
client replies to reply+<token>@inbox.bythereeses.com
  → Cloudflare Email Routing (catch-all on inbox.bythereeses.com)
  → Worker  workers/project-email-inbound.ts   (new; models workers/inquiry-intake.ts)
  → POST /api/inbound/project-email             (new; models /api/inbound/inquiry-email)
  → src/lib/inbound-project-email.ts            (new; REUSES 8a parsers/sanitizers)
  → append ONE project_communications row (direction inbound, channel email)
```

The Worker does minimal work (size gate, header capture, cap raw body, POST) and **never silent-drops**: every exit path `message.forward(env.INTAKE_FALLBACK)` to a verified human inbox, exactly like `inquiry-intake.ts` (flag-off → forward; oversize → forward; redirect/non-2xx → forward; throw → forward). It uses `redirect: "manual"` and treats `res.redirected || res.type === "opaqueredirect" || 3xx || !res.ok` as not-persisted → forward (the 8a REJECT-class defense against a proxy login-wall 200 being read as success). `setReject` is used nowhere.

The reply address uses a **dedicated subdomain** `inbox.bythereeses.com` so the catch-all reply mailbox never collides with the 8a `inquiries@bythereeses.com` address or `hello@`. The outbound `From` stays `hello@bythereeses.com` (deliverability/brand); only `reply_to` carries the token.

### 2.2 The token — recommended design (Option A: stateless keyed, mirrors `unsubscribe-token.ts`)

**Recommendation: a stateless HMAC-derived token, no per-row secret stored** — the direct analog of `src/lib/unsubscribe-token.ts` (sign against a dedicated secret, verify constant-time, fail closed). New lib `src/lib/project-reply-token.ts`:

```
mintProjectReplyToken(projectId): string | null             // null ⇒ caller omits reply_to entirely
  if REPLY_TOKEN_SECRET unset: return null                   // fail-closed mint (build note)
  raw16 = the 16 bytes of the project UUID
  idPart  = base64url(raw16)                                  // 22 chars (no padding)
  tag     = base64url( HMAC-SHA256(REPLY_TOKEN_SECRET,
                       "project_reply\n" + projectId).slice(0,16) )  // 128-bit, 22 chars
  return `${idPart}.${tag}`                                   // 45 chars

verifyProjectReplyToken(token): { projectId } | null         // fail-closed; constant-time
  // 1. Strict extraction is the caller's job (§2.3 step 1): token is the two
  //    22-char base64url parts already split on the single ".".
  // 2. base64url-DECODE idPart → 16 raw bytes → reconstruct the UUID string
  //    LOWERCASE, matching crypto.randomUUID() output.
  // 3. Recompute HMAC over the DECODED projectId bytes ("project_reply\n"+uuid),
  //    NOT over the raw idPart string; timingSafeEqual against the supplied tag.
  // 4. Any failure (secret unset, bad length, decode error, tag mismatch) → null.
```

Reply address = `reply+<token>@inbox.bythereeses.com`. Local part = `reply+`(6) + 45 = **51 chars ≤ 64** (RFC 5321 local-part limit); base64url's alphabet (`A–Z a–z 0–9 - _`) plus `.` and `+` are all legal local-part characters.

**Fail-closed mint (build note).** When `REPLY_TOKEN_SECRET` is unset, `mintProjectReplyToken` returns `null` and the outbound sender **omits `reply_to` ENTIRELY** — it must NOT attach an empty-tag `reply+<id>.@inbox...` address (that would be an un-verifiable local part that bounces or dead-letters). Two-way simply stays dark (outbound still sends with no reply token) until the secret is set. `verifyProjectReplyToken` returns `null` for any input while the secret is unset — fail closed, identical to `unsubscribe-token.ts`.

**Runtime.** `verifyProjectReplyToken` runs in the Node-runtime inbound endpoint (like the 8a route), so `node:crypto` `createHmac` + `timingSafeEqual` are used directly — the WebCrypto constraint applies only to edge middleware, and verification deliberately lives in the Node endpoint, not the Email Worker (build note).

Why this over a stored random token:
- **Reuses a proven, Fable-approved pattern** (unsubscribe-token) verbatim — no new bearer-secret-at-rest to protect, no lookup, no migration for the token itself.
- **The tag binds `projectId`**, so a token minted for project A can never verify against project B (cross-thread injection impossible) — the same binding property that stops unsubscribe-token A from suppressing email B.
- **Fail-closed** on unset secret.
- Verify runs in the Node-runtime endpoint (like the 8a route uses `node:crypto`), so `node:crypto` HMAC + `timingSafeEqual` are available — no edge/WebCrypto constraint here.

Why NOT store the token: hashing-at-rest (the "store hashed if bearer-like" lesson) requires the plaintext at *send* time to embed it in every outbound Reply-To — which forces you to keep the plaintext anyway, defeating the hash. A **keyed derivation** is strictly better: nothing per-project is stored, and the secret (not a DB row) is the protection.

**Rejected alternatives:**
- *Option A′ — per-project random token in a hashed column.* Viable but needs the plaintext at send time (see above), adds a column + lookup, and buys only per-project revocation. Not worth it given the tiny blast radius (§3.3). Keep as the documented fallback if per-project revocation ever becomes a hard requirement.
- *Option B — match by `From` address → known client.* This is the task's fallback (b). **Rejected as an auto-attach authority.** `From` is trivially spoofable (the Active-Learning rule: SPF/DKIM/DMARC and by extension `From` are *display* signals, never authz). A `From`-only match is at most a **triage hint**, never an append. See §2.4.

**Optional future revocation** (do NOT build in MVP): add `projects.reply_token_version INTEGER NOT NULL DEFAULT 1` and fold it into the HMAC input (`"project_reply\n" + projectId + "\n" + version`); bumping the column rotates *one* project's outstanding tokens. MVP uses global rotation via `REPLY_TOKEN_SECRET` (blast radius makes this sufficient).

### 2.3 Ingest logic — `src/lib/inbound-project-email.ts`
Reuse (import, do not reimplement) from `inbound-inquiry.ts`: `sanitizeLine`, `sanitizeBody`, `stripHtmlToText`, `extractPlainTextFromRaw`, `parseNameAndEmail`, `normalizeEmail`, `parseAuthResults`, `extractMessageIdTokens`, `extractAttachmentMetadata`, and every `MAX_*` cap. Payload shape is the existing `InboundEmailPayload` (extended: the Worker also passes the full recipient address so we can read the token — it is `message.to`, already in `envelopeTo`).

`ingestInboundProjectEmail(payload)`:
1. **Strict token extraction, then** `verifyProjectReplyToken`. Read the recipient from `payload.envelopeTo` (the SMTP **envelope** recipient = `message.to`), NEVER from the attacker-controlled `To`/`Reply-To` headers. Lowercase ONLY the domain part, then match the local part against an anchored, case-sensitive regex `/^reply\+([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/` (base64url is case-significant — do not lowercase it). A non-match → non-attach → forward. On match, pass the two captured 22-char parts to `verifyProjectReplyToken`. **No valid token → return a non-attach result** so the endpoint answers non-2xx and the Worker forwards to the human fallback (§2.4). This is the only authority for attaching; nothing else appends.
2. Verify the resolved `projectId` exists (project may be deleted). Missing → non-attach → forward.
3. Sanitize every field with the 8a sanitizers: `subject = sanitizeLine(payload.subject, MAX_SUBJECT_LENGTH)`, `bodyText = sanitizeBody(extractPlainTextFromRaw(payload.raw), MAX_BODY_TEXT_LENGTH)`, `messageId = sanitizeLine(payload.messageId, MAX_MESSAGE_ID_LENGTH)`, `{ name, email } = parseNameAndEmail(headerFrom, envelopeFrom)`, `auth = parseAuthResults(payload.authResults)` (Cloudflare authserv-id only, **display-only**), `attachments = extractAttachmentMetadata(payload.raw)`.
4. **Rate/volume guard** mirroring 8a `isRateLimited` (global hourly + per-domain hourly), but counting inbound project-email rows — **plus a per-`projectId` hourly cap** (Finding LOW 4). The global+per-domain caps alone do NOT deliver "a stolen token cannot flood a thread": a token holder rotating sender domains stays under the per-domain cap and drives ~200 rows/hr into one thread until the global cap trips — which also chokes legitimate intake. Add a per-projectId hourly cap (e.g. `PROJECT_HOURLY_INSERT_CAP = 25`, counting inbound-email rows on that projectId in the trailing hour) evaluated alongside the global and per-domain caps. Over any cap → drop the append and log an activity row (never a canonical write); return a non-attach result (worker forwards → throughput cost, not a safety hole).
5. **Dedupe + append** using the **converge pattern** (D1 has no usable transaction — Active-Learning): `INSERT ... ON CONFLICT(project_id, inbound_message_id) DO NOTHING`, then re-read by our generated `id` to see if our row won; if not, an existing row already holds this Message-ID **for this project** → idempotent replay, return `{ deduped:true }` with NO second row, NO UPDATE of the existing row. Dedupe is scoped to the thread (composite key, §5, Finding MEDIUM 2): the SAME Message-ID replayed to the SAME project is an idempotent no-op, but the same Message-ID arriving for a DIFFERENT project (one client emailing two of their projects' reply tokens → one Worker invocation per recipient) correctly appends to each project's thread instead of being silently swallowed. NULL Message-ID never conflicts (SQLite treats NULLs distinct) → always a fresh append (rate-limit bounds abuse). The appended row:
   - `direction:"inbound"`, `channel:"email"`, `status:"archived"` (mirrors inbound SMS in `twilio-webhook.ts` `insertInboundCommIfNew` — appears in the thread, is never an actionable outbound draft),
   - `createdBy:"system"`, `subject`, `body: bodyText`, `recipientName: name`, `recipientEmail: email` (the client's From, best-effort),
   - `inbound_message_id`: the sanitized Message-ID (dedupe key; see §5),
   - `clientId`: best-effort `clients.email === email` on this project's participants, else null,
   - `sourceType:"inbound_project_email"`, attachments recorded in a JSON note if present.
6. `logActivity("project.communication.inbound_email_received", { projectId, from, matchedClient, spf:auth.spf, dkim:auth.dkim, dmarc:auth.dmarc })` — auth verdicts are logged as **display signals for Tyler**, never used to decide anything.
7. Return `{ id, deduped }` so the endpoint answers 2xx **only after the row is durably written** (persist-then-2xx; no `waitUntil` fire-and-forget — the Workers cancel-after-response lesson).

**The token authorizes ONLY this append.** `ingestInboundProjectEmail` has zero access to canonical-write functions — no project/client/finance mutation, no send, no agent tool. This is the same B1 zero-authority discipline as 8a's `draftFromInquiry`, and must be asserted by a guard test (§7) that feeds a hostile body and proves zero canonical rows change beyond the one comm + activity row.

### 2.4 Unmatched / invalid → never silent-drop
No valid token (mangled, someone emailed `inbox@` directly, deleted project, rate-limited) → the endpoint returns non-2xx → the Worker `message.forward(INTAKE_FALLBACK)` to a verified human inbox. This is the 8a no-silent-drop guarantee, unchanged. Optionally the endpoint also writes an `activity_logs` row for visibility, but the authoritative safety net is the forward. `From`-match is **not** consulted to auto-attach; if we want Tyler to see a "possible existing project" hint we can (later) surface it in a triage view mirroring 8a's read-only `possibleExistingClientId`, but that is a display hint, never an append.

---

## 3. Security (make-or-break)

### 3.1 Token entropy and exactly what it grants
- **Entropy / forgery.** The tag is 128-bit HMAC-SHA256 keyed by `REPLY_TOKEN_SECRET`. Forging a valid tag for a chosen project without the secret is a 2^-128 event; guessing is 2^-128. The `idPart` (base64url of the project UUID) is *reversible* — that is fine: knowing a project's id grants nothing without a valid tag, and the tag binds the id so it cannot be transplanted.
- **What a valid token grants: exactly one capability** — appending an INBOUND message row to that ONE project's thread. It grants **no** read, **no** canonical mutation (project/client/finance/timeline/source), **no** outbound send, **no** agent-tool invocation, and **no** cross-project reach (the tag binds `projectId`).
- **Exposure.** The token rides in the `Reply-To` of every project email, so it is semi-public (readable by the client, their mail provider, any forward recipient). Treat it as a capability, not a secret: its power is deliberately minimal so exposure is low-consequence.

### 3.2 What an attacker who obtains/guesses one can do — and the blast-radius cap
- **Guess:** infeasible (128-bit).
- **Obtain (from a forwarded email):** they can email `reply+<token>@inbox...` and inject an inbound message row into that single project's thread, with an attacker-chosen (spoofable) `From` and body.
- **Blast radius is capped to one thread, message-injection only, and cannot escalate:**
  1. The row is `direction:"inbound"`, HTML-stripped (`stripHtmlToText`), every field capped, rendered as an untrusted "received" message — Tyler reads it skeptically, with SPF/DKIM/DMARC shown as display verdicts.
  2. **Rate-limited** per-`projectId` + per-domain + global hourly → a token can't flood the thread even by rotating sender domains (the per-domain+global caps alone leave a domain-rotation flood path that also chokes legitimate intake; the per-projectId cap is what actually bounds a single stolen token — Finding LOW 4).
  3. **Message-ID dedupe** (`INSERT ON CONFLICT(project_id, inbound_message_id) DO NOTHING`) prevents replay amplification within a thread, while still letting one client's message to two of their projects land in both (Finding MEDIUM 2).
  4. **No field the inbound row writes is read by any canonical / agent / finance / send path** — there is no privilege to escalate into. It cannot cause an outbound send, a project mutation, or an agent action.
  5. **Revocable** by rotating `REPLY_TOKEN_SECRET` (global; optional per-project version for surgical revocation, §2.2).
- The correct mental model: a leaked token = "anyone can leave a note in this one project's inbox pile," not "anyone can act as the client."

### 3.3 SPF/DKIM/DMARC and `From` are display-only, never authz
Reuse `parseAuthResults` exactly as 8a: only Cloudflare's prepended authserv-id is parsed, joined-header smuggling is truncated, an unrecognized authserv-id yields all-null. The verdicts are stored/shown for Tyler's judgment and never gate attachment. A valid token is **not** proof the sender is the client (a token holder can spoof `From`); we never take a canonical action off an inbound message, so this is acceptable — and it is exactly why `From`-match can never be an auto-attach authority (§2.2 Option B rejected).

### 3.4 Hostile-field handling (every field capped/sanitized)
Reuse the 8a sanitizers verbatim: control-char + CR/LF/NEL/LS/PS stripping (`sanitizeLine`), body newline-preserving strip + cap (`sanitizeBody`), `stripHtmlToText` (removes script/style with contents, all tags, `javascript:`/`data:` URIs, decodes entities). Never render inbound HTML — store/display only the text projection. Caps: subject 500, body 50 000, Message-ID 998, addresses 320, attachments metadata-only (never parsed/opened), ≤20 recorded. Subject is additionally re-checked at any point it could become a header.

### 3.5 Attacker-chosen Message-ID → dedupe, never UPDATE (B2)
`(project_id, inbound_message_id)` is the dedupe key (composite — scoped to the thread, not global, §5, Finding MEDIUM 2): `INSERT ON CONFLICT(project_id, inbound_message_id) DO NOTHING`, then re-read to see if our row won; a duplicate **for the same project** is an idempotent no-op that returns the existing id and **never UPDATEs** the existing row from inbound data. The same Message-ID for a *different* project is not a conflict, so a client emailing two of their projects' reply tokens lands in both threads rather than being silently dropped (the exact hole §2.4 promises is closed). NULL Message-ID is always a fresh row (can't dedupe → rate-limit is the bound). This is the 8a `ingestInboundInquiry` discipline (lines 527-544) applied to the comm table, with the dedupe scope widened from global to per-thread.

### 3.6 Proxy composition — the 8a REJECT class (reviewed explicitly against the live boundary)
Two endpoints, two different, deliberate placements:

- **Inbound `/api/inbound/project-email` (machine, bearer-authed, must be proxy-reachable):**
  - Add to `isStudioPublicPath` in `pages-proxy/_worker.js` (so the proxy does not 303 it to `/admin/login`, whose 200 login page a `redirect:follow` client would misread as success — the exact 8a/reminders-cron trap).
  - Add an exemption in `adminProofRequired` in `src/lib/admin-proxy-auth.ts` (so `ADMIN_PROOF_ENFORCE=1` doesn't 404 the POST). Comment it identically to the existing `/api/inbound/inquiry-email` exemption (line 203).
  - Add a `rateLimitKind` branch (POST → a **dedicated, generous** bucket, NOT the shared `publicMutation` 20/300s, alongside the existing 8a intake branch at `_worker.js` line 308). All inbound project mail arrives via ONE Worker with concentrated egress (the `twilioWebhook` lesson — a single machine source behind the proxy is not per-user public traffic), so a stingy `publicMutation` bucket would throttle legitimate bursts; the failure mode of exceeding this bucket is forward-to-human (throughput cost), not a safety hole, so prefer a generous dedicated kind (build note).
  - **NOT** in the origin-guard bypass lists (`isPublicOriginBypassApiPath`) → reachable **only** through the proxy, which stamps `x-reese-origin-secret`; a direct `*.workers.dev` POST is 404'd by `guardDirectWorkerApiRequest`. The dedicated bearer `INBOUND_PROJECT_EMAIL_SECRET` at the origin is the trust boundary.
  - Pin these against the proxy predicates with the existing **drift test** (`admin-surface-classification.test.ts`) so app and proxy classifiers cannot silently diverge.
- **Outbound `/api/projects/[id]/communications/send-email` (admin, must NOT be agent/machine-reachable):**
  - **NOT** in `isStudioPublicPath`, **NOT** in `adminProofRequired` exemptions, **NOT** in any origin bypass, **NOT** an MCP tool → default "genuine admin surface" (Google session + admin proof). `guardDirectWorkerApiRequest` blocks direct-origin. Identical trust model to `send-sms/route.ts` (documented in its header comment, lines 6-30).

### 3.7 Fail-closed secrets & runtime rules
- `REPLY_TOKEN_SECRET` unset → `mintProjectReplyToken` returns `null` so outbound omits `reply_to` ENTIRELY (no empty-tag bouncing address), and `verifyProjectReplyToken` returns `null` for all input (fail closed).
- `INBOUND_PROJECT_EMAIL_SECRET` unset → endpoint 503 (fail closed, non-2xx → worker forwards).
- `RESEND_API_KEY` unset → send returns not-configured, draft stays, no false "sent".
- Read all flags **inside the function body** (not `env = process.env` default params) to avoid the TS2559 weak-type build failure (`smsEnabled`/`refundInitiationEnabled` pattern).
- Persist-then-2xx everywhere; no unawaited post-response work (Workers cancel it). Constant-time compares for every secret/token/signature.

---

## 4. Unified thread UI

The Communications section (`page.tsx` lines 1006-1266) already lists all `project_communications` for the project; email, SMS, call, and note rows already coexist there ordered `desc(createdAt)`. Phase 14 makes it read as one two-way thread:

1. **Direction + channel affordance.** Render an inbound/outbound indicator and a channel icon (`Mail` for email, an SMS glyph for sms). Inbound rows show the sender (`recipientName`/`recipientEmail` currently hold the parsed From for inbound). Existing inbound SMS rows already flow through here (`twilio-webhook.ts` appends them); inbound email rows now do too, so no new list plumbing — just presentation.
2. **Email send affordance** mirroring the SMS block (page.tsx lines 1159-1188). For a row where `channel === "email" && status === "draft" && direction === "outbound"`, resolve the recipient server-side (the same `resolveRecipient` resolution the send path uses — §1.3 step 5) and render a "Send email" form POSTing to `/api/projects/[id]/communications/send-email` with hidden `communicationId` and `approvedBodyHash = emailApprovalHash(subject, body, resolvedRecipient)` computed server-side (page.tsx already imports the hash helper). Binding the **displayed** recipient into the hash is what makes the send path's re-resolution + hash check reject a post-review `recipientEmail` swap (§1.2, Finding MEDIUM 1). Gate the button on `emailSendingEnabled()` + a resolvable recipient + not-suppressed (a display-only precheck mirroring `checkSmsDraftConsent`/`smsConsentReasonLabels`; the server gate stays authoritative). Surface typed refusals via an `emailError` query param + an `emailSendErrorMessages` map mirroring `smsSendErrorMessages` (page.tsx lines 58-69) — no silent drops.
3. **Retire "Mark sent" for email.** The generic log-only "Mark sent" (lines 1140-1156) currently applies to email/call/note. Narrow it to `call`/`note` only (relabel to "Log as sent (no send)") so email drafts go through the real gated send. A manually-sent-elsewhere email can still be logged via the edit form's status field, but the primary path is the real send — closing the "flip a status, pretend it sent" gap for email the same way it was closed for SMS.
4. **Delivery status.** Show `deliveryStatus`/`providerMessageId` for email like the existing SMS `Twilio status` line (page.tsx line 1127-1129).
5. Add the `saved === "email_sent"` and `emailError` banners mirroring `sms_sent`/`smsError` (lines 330-340). Extend the page `searchParams` type accordingly.

---

## 5. Migration 0092 (additive; mirrored in 3 places)

Only one new column is needed — the reply token is stateless (§2.2), so it needs no storage. The one addition is the inbound dedupe key.

**`migrations/0092_inbound_project_email.sql`:**
```sql
-- Phase 14: two-way per-project email. Additive, idempotent.
-- inbound_message_id dedupes replayed inbound client replies (INSERT ON CONFLICT
-- DO NOTHING, never UPDATE from inbound). Separate from provider_message_id
-- (which holds the Twilio SID / Resend outbound id) to keep inbound dedupe clean.
ALTER TABLE project_communications ADD COLUMN inbound_message_id TEXT;
-- Dedupe is scoped to the THREAD, not globally: one client emailing two of their
-- projects' reply tokens (reply+<tokenA>@ AND reply+<tokenB>@) makes Cloudflare
-- invoke the Worker once per recipient with the SAME Message-ID. A global unique
-- index would let project A's row win and project B's identical Message-ID hit
-- ON CONFLICT DO NOTHING → 2xx → Worker does not forward → the message never
-- reaches project B and never reaches the human fallback = a silent cross-project
-- drop (Finding MEDIUM 2). Scoping to (project_id, inbound_message_id) makes a
-- replay to the SAME project an idempotent no-op while a genuine two-project
-- message correctly appends to both threads.
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_communications_project_inbound_message_id
  ON project_communications(project_id, inbound_message_id);
```
(SQLite treats multiple NULLs as distinct, so the UNIQUE index does not collide across the many existing NULL rows.)

This is a schema-additive, flag-gated feature (inbound is dark until `INBOUND_PROJECT_EMAIL_ENABLED`), so it may migrate anytime; still apply via the idempotent direct `d1 execute --file` pattern (not blanket `migrations apply --remote`), and per the migration-ordering rule **apply 0092 BEFORE the app deploy**. The binding reason is not the append path (which is flag-dark) but the **ALWAYS-ON project-page read** (build note): once `schema.ts` declares `inboundMessageId`, Drizzle selects every mapped column on every project-page load, so an app build carrying the new column against an un-migrated D1 500s **every project page** regardless of any flag. Migrate-first is therefore mandatory, not merely prudent.

**3-place mirror (must all match, per the Active-Learning migration-3-place rule):**
1. `src/db/schema.ts` — add `inboundMessageId: text("inbound_message_id")` to `projectCommunications` (after `deliveryStatus`, line 385).
2. `src/db/client.ts` dev-migrate — `addColumnIfMissing(database, "project_communications", "inbound_message_id", "TEXT")` and the `CREATE UNIQUE INDEX IF NOT EXISTS idx_project_communications_project_inbound_message_id ON project_communications(project_id, inbound_message_id)` (alongside the existing 8b block at lines 668-678). Composite key — must match the migration exactly.
3. `src/db/studio-canon.test.ts` — assert the column and the **composite** `(project_id, inbound_message_id)` unique index exist (mirroring the existing `idx_project_communications_*` assertions around lines 413-445; assert the index columns, not just its presence) and add/extend a canon assertion that an inbound-email append changes no other canonical table.

If per-project token revocation is later required, a second additive migration adds `projects.reply_token_version` — deferred, not in 0092.

---

## 6. Flags, rollout, and Tyler provider-config steps

### 6.1 Flags (all OFF by default; enablement flips are Tyler's, guardrail 2)
- `EMAIL_SENDING_ENABLED` — outbound. `emailSendingEnabled()` returns `process.env.EMAIL_SENDING_ENABLED === "1"` (strict `=== "1"`, read in body, mirror `smsEnabled`). OFF → `sendApprovedProjectEmail` returns `flag_off`, draft stays; the UI disables the Send button and shows "Email sending is currently disabled."
- `INBOUND_PROJECT_EMAIL_ENABLED` — inbound endpoint server flag (`"true"`, mirror `isInquiryIntakeEnabled`). OFF → endpoint 503 → worker forwards to human (never attaches, never drops).
- Worker `INTAKE_ENABLED` var (`"false"` default) — flag-off forwards every message to `INTAKE_FALLBACK`.
- `REPLY_TOKEN_SECRET` — fail-closed unset (no token minted; no inbound verifies). Two-way stays dark until set.

### 6.2 New secrets/vars
- App (Worker origin): `EMAIL_SENDING_ENABLED`, `INBOUND_PROJECT_EMAIL_ENABLED`, `INBOUND_PROJECT_EMAIL_SECRET`, `REPLY_TOKEN_SECRET`, `REPLY_INBOX_DOMAIN` (default `inbox.bythereeses.com`). Reuse existing `RESEND_API_KEY`, `RESEND_FROM_EMAIL`.
- Inbound Worker (`wrangler.project-email-inbound.jsonc`, modeled on `wrangler.inquiry-intake.jsonc`): `INTAKE_ENDPOINT=https://studio.bythereeses.com/api/inbound/project-email`, `INBOUND_PROJECT_EMAIL_SECRET`, `INTAKE_ENABLED="false"`, `INTAKE_FALLBACK` = a **verified** Email Routing destination.

### 6.3 Tyler provider-config runbook (documented; not autonomous)
1. **DNS/subdomain:** add `inbox.bythereeses.com` to Cloudflare Email Routing (MX + verification). Verify the `INTAKE_FALLBACK` destination address (an unverified address does not deliver — that would reintroduce a silent drop).
2. **Email Routing rule:** catch-all `*@inbox.bythereeses.com` → **Send to a Worker** → `reese-project-email-inbound`.
3. **Resend:** confirm the `bythereeses.com` sending domain is verified (already is for 8c). No Resend inbound config needed — `reply_to` is just a header; replies flow to Cloudflare Email Routing, not Resend.
4. **Secrets:** `wrangler secret put` `REPLY_TOKEN_SECRET`, `INBOUND_PROJECT_EMAIL_SECRET` (both the app Worker and the inbound Worker share the same `INBOUND_PROJECT_EMAIL_SECRET` value, like 8a).
5. **Deploy dark:** migrate 0092 → deploy app Worker + inbound Worker + proxy → health-check → keep all flags OFF.
6. **Enable (Tyler, after observation):** (a) set `REPLY_TOKEN_SECRET`; (b) flip `EMAIL_SENDING_ENABLED=1` and send one real email, confirm the `reply_to` token and delivery; (c) flip inbound `INTAKE_ENABLED="true"` + `INBOUND_PROJECT_EMAIL_ENABLED="true"`, reply to that email, confirm it lands in the right project thread; (d) watch the fallback inbox for any forwarded (unmatched) mail.

Every deploy uses the standard rails (D1 backup → capture rollback version → deploy → health-check → auto-rollback on failure).

---

## 7. Test plan (tsx; build exit code)

Gate on `npm run build` **exit code 0** (type-check catches TS2559 etc. after "Compiled successfully"); tsx tests do not type-check.

**Outbound (`project-communications` / send-email):**
- content-hash refuse-on-mismatch: stored subject or body changed after review → `hash_mismatch`, zero Resend calls, refusal logged.
- **recipient-redirect refuse (Finding MEDIUM 1):** after review, an agent sets ONLY `recipientEmail` to an attacker address (status stays `draft`, subject/body unchanged) → the send path re-resolves the recipient, the recipient-bound hash no longer matches → `hash_mismatch`, **zero Resend calls**, refusal logged. Assert the approved email was never delivered to the swapped address.
- suppression honored: recipient in `email_suppressions` → `suppressed`, no send, draft intact.
- flag off: `EMAIL_SENDING_ENABLED` unset → `flag_off`, draft intact.
- fail-closed key: `RESEND_API_KEY` unset → `not_configured`, never marked sent.
- length cap: body > `EMAIL_BODY_MAX_LENGTH` refused at create/update and at send (`too_long`).
- subject header-injection: a subject containing CR/LF is folded by `stripReplySubjectForSend`, or throws if a newline survives.
- not-draft / not-outbound / inbound row → `not_draft` (no double-send, no send-back).
- delivered path: `status→sent`, `providerMessageId` captured, `deliveryStatus:"sent"`.
- ambiguous (5xx/network) → draft stays, no false sent.
- **agent cannot send:** no MCP tool reaches the send route; a hostile `studio_create_communication` with `channel:"email", status:"sent"` from the agent actor lands `draft` (§8); a hostile `studio_update_communication` that re-channels + sends in one patch (`note`→`email` with `status:"sent"`, and `sms`→`email`+`sent`) also lands `draft` (clamp keys off `nextChannel`); `studio_draft_email` hard-forces draft. Assert **zero Resend calls** in all cases. Guard test mirrors `sms-guard.test.ts`.

**Inbound (`inbound-project-email` / endpoint / worker):**
- valid token → attaches to the RIGHT project (row `direction:inbound, channel:email` on that projectId).
- token minted for project A does NOT attach to project B (tag binds projectId → verify returns A only).
- **spoofed `From` does NOT attach** — only a valid token attaches; a message with a real client `From` but no/invalid token is not appended (forwarded to human).
- unmatched / invalid / deleted-project / flag-off / rate-limited → endpoint non-2xx → worker `forward` (no silent drop); assert `redirect:manual` treats a 3xx/opaqueredirect as failure.
- hostile fields capped/sanitized: oversized subject/body truncated; HTML body → text-only (`stripHtmlToText`); control chars/CRLF stripped; `javascript:`/`data:` neutralized.
- Message-ID replay → dedupe (same thread): second POST with the same `inbound_message_id` **to the same project** → `ON CONFLICT(project_id, inbound_message_id) DO NOTHING`, one row, existing row NOT updated.
- **cross-project same Message-ID appends to BOTH (Finding MEDIUM 2):** one client's message carrying two projects' reply tokens (`reply+<tokenA>@` and `reply+<tokenB>@`) delivers the SAME Message-ID to project A and project B → a row appended to EACH thread (composite key does not conflict across projects), neither silently dropped, and (with inbound flag off/forward paths) never lost to the human fallback via a false 2xx.
- per-`projectId` hourly cap (Finding LOW 4): a token holder rotating sender domains over the per-project cap into ONE thread → over-cap appends become non-attach → forward (does not have to exhaust the global cap to be bounded).
- NULL Message-ID → still appended (not dropped), rate-limit bounds abuse.
- **zero canonical authority:** a fully hostile payload writes only the one comm row + activity row; no project/client/finance/timeline/source row changes (guard test mirroring `inbound-inquiry-guard.test.ts`).
- SPF/DKIM/DMARC parsed from Cloudflare authserv-id only, stored display-only, never gate attachment.

**Token lib:**
- format/entropy; verify constant-time; fail-closed on unset `REPLY_TOKEN_SECRET`; round-trip mint→verify→projectId; tamper (flip a tag byte) → null.

**Proxy composition (drift tests):**
- `/api/inbound/project-email` ∈ `isStudioPublicPath` AND exempt in `adminProofRequired` AND NOT in origin-bypass; `guardDirectWorkerApiRequest` 404s a direct `*.workers.dev` POST.
- `/api/projects/[id]/communications/send-email` NOT public, NOT bypass, requires admin surface; pinned by the classifier drift test.

---

## 8. Agent authority gap to close

Today the agent send-clamp only covers SMS: `createProjectCommunication`/`updateProjectCommunication` force `status:"draft"` when `actor.actorType === "agent" && channel === "sms"` (project-communications.ts lines 170, 233-236). **Email is unclamped**, so a prompt-injected agent could mint `channel:"email", status:"sent"` — a false "we emailed them" record (and, once a real send exists, a truthfulness hazard). Close it symmetrically:

- Widen the clamp to `(channel === "sms" || channel === "email")` for the agent actor in **both** create (`project-communications.ts:170`) and update (`233-236`), so an agent-authored email row can only ever land `draft`. The update clamp must key off the **resolved `nextChannel`** exactly as the SMS clamp does, so a single hostile patch that RE-CHANNELS and sets send-state at once (e.g. `note`→`email` **with** `status:"sent"`, or `sms`→`email`+`sent`) is still caught — the clamp condition is `actor.actorType === "agent" && (nextChannel === "sms" || nextChannel === "email") && (requestedStatus === "sent" || requestedStatus === "queued") ? "draft" : requestedStatus`, mirroring the existing `nextChannel` handling rather than testing the pre-patch channel. (Non-agent actors are unaffected: the 8a `approveInquiryReply` inserts its `sent` email row via a direct `db.insert` with an admin actor name, and the Phase 8c sequence runner uses `systemActor` — neither goes through the agent clamp, so auto-send email and inquiry replies keep working.)
- Add `studio_draft_email` to `studio-mcp.ts` mirroring `studio_draft_sms` (lines 2905-2922): hard-force `channel:"email", status:"draft", direction:"outbound"`, description states it has zero send authority. This gives agents a clean "draft an email for Tyler" tool that structurally cannot send.

Result: for both channels, the ONLY way a message actually leaves the system is Tyler's admin-only send route — "agents draft, Tyler sends" becomes a table-level invariant for email, matching SMS.

---

## 9. Reuse map (reuse, do NOT reimplement)

| Concern | Reused from | New/changed |
| --- | --- | --- |
| Resend transport, from/reply-to, key fail-closed | `src/lib/email.ts` `resendRequest` | add `reply_to` + capture message id; thin `sendProjectEmail` |
| Suppression gate | `email.ts` `isEmailSuppressed` | called by `sendApprovedProjectEmail` |
| Content-hash approval, typed refusals, admin send | `project-communications.ts` `sendApprovedProjectSms`, `sha256Hex` | `sendApprovedProjectEmail`, `emailApprovalHash` |
| Admin-only send route shape | `api/.../communications/send-sms/route.ts` | `send-email/route.ts` |
| Inbound transport (Email Routing→Worker→endpoint), no-silent-drop, `redirect:manual` | `workers/inquiry-intake.ts`, `api/inbound/inquiry-email/route.ts` | `workers/project-email-inbound.ts`, `api/inbound/project-email/route.ts` |
| MIME parse, sanitizers, caps, auth-results, attachments, Message-ID tokens | `src/lib/inbound-inquiry.ts` (all exported) | imported by `inbound-project-email.ts` |
| Inbound append + dedupe + unmatched handling | `src/lib/twilio-webhook.ts` `insertInboundCommIfNew` | `inbound-project-email.ts` |
| Signed-token, fail-closed, constant-time | `src/lib/unsubscribe-token.ts` | `project-reply-token.ts` |
| Thread UI + SMS send affordance + typed error banners | `app/projects/[id]/page.tsx` (SMS block) | email send block + inbound rendering |
| Proxy composition (public-path + admin-proof exempt + NOT origin-bypass) | `_worker.js`, `admin-proxy-auth.ts`, `origin-guard.ts` | add project-email endpoint; send-email stays default-admin |
| OFF-flag pattern (`=== "1"`, read in body) | `sms.ts` `smsEnabled`, `finance-flags.ts` | `emailSendingEnabled`, inbound flags |
| Migration 3-place mirror | `schema.ts` / `client.ts` / `studio-canon.test.ts` | 0092 |

---

## 10. Ordered task breakdown (effort / risk)

1. **Migration 0092 + 3-place mirror** (`inbound_message_id` col + **composite** `(project_id, inbound_message_id)` unique index, §5). Apply migrate-FIRST before the app deploy (always-on project-page column read, not the append path — §5). *S / low.*
2. **`project-reply-token.ts`** (mint/verify, mirror unsubscribe-token) + unit tests. Fail-closed mint returns `null` ⇒ caller omits `reply_to`; verify decodes idPart to lowercase UUID and HMACs the DECODED bytes; strict anchored extraction of the two 22-char base64url parts lives at the ingest boundary (§2.2/§2.3). `node:crypto` in the Node endpoint. *S / med (security).*
3. **`email.ts` additions** — `reply_to`, capture Resend id, `sendProjectEmail` (existing callers untouched). *S / low.*
4. **`sendApprovedProjectEmail`** + recipient-binding `emailApprovalHash(subject, body, recipient)` (resolve recipient BEFORE hash check, §1.2/§1.3, Finding MEDIUM 1) + `assertEmailBodyLength` + email-subject newline strip at create/update + `emailSendingEnabled` + agent email clamp widened to catch re-channel (`nextChannel`, §8). *M / med.*
5. **`send-email` admin route** (mirror send-sms) + `emailError`/`email_sent` PRG. *S / low.*
6. **`studio_draft_email` MCP tool** + confirm generic create/update email clamp; guard test. *S / med (agent authority).*
7. **`inbound-project-email.ts`** — reuse 8a parsers, strict envelope-recipient token extraction + verify, converge-dedupe append on the **composite** `(project_id, inbound_message_id)` key (§2.3/§3.5), rate guard incl. **per-projectId hourly cap** (Finding LOW 4), zero-authority guard test. *M–L / HIGH (untrusted input).*
8. **`/api/inbound/project-email` route** (mirror 8a) + proxy composition (`isStudioPublicPath` + `adminProofRequired` exempt + a **dedicated generous** `rateLimitKind`, not `publicMutation`; NOT origin-bypass) + drift test. *M / HIGH (proxy REJECT class).*
9. **`workers/project-email-inbound.ts`** + `wrangler.project-email-inbound.jsonc` + Email Routing (config is Tyler's). *S code / med.*
10. **Unified thread UI** — direction/channel affordance, email send block, retire email "Mark sent", banners, delivery status. *M / low–med.*
11. **Flags/rollout doc + Tyler runbook** (this §6 as the source of truth). *S / low.*
12. **Full test pass** (build exit code + all §7 suites) + adversarial Fable review before branch/deploy. *S / med.*

Highest-risk items (7, 8) are the untrusted-input + proxy-composition surfaces — build with the Active-Learning Log seeded and Fable-review them against the **live** proxy/origin-guard/admin-proof boundary, not just their own files.

---

## Changelog

### Rev 2 (Fable spec-review) — folded in; reviewer confirmed re-gate NOT required
This revision folds a Fable review (2 MEDIUM + 2 LOW + build notes) directly into the spec; each fix was verified against the cited code before writing.

| # | Sev | Finding | Fix folded in | Sections |
| --- | --- | --- | --- | --- |
| 1 | MEDIUM | Approval hash covered only subject+body. A prompt-injected agent could `studio_update_communication` setting ONLY `recipientEmail` after Tyler's review (status stays `draft`, subject/body unchanged ⇒ old hash still matches), redirecting proposal links + client PII to an attacker while the row reads "sent". SMS is structurally immune (recipient derives from consented `clientId`), so "mirror SMS" dropped a protection. *Verified: `UpdateProjectCommunicationInput.recipientEmail` + patch-loop forward at `studio-mcp.ts:2898`/`project-communications.ts:255`; SMS hash is body-only at `:397`.* | `emailApprovalHash` now binds the **resolved recipient**; the send path RE-RESOLVES the recipient (step 5) BEFORE recomputing + checking the hash (step 6); the UI affordance computes the hash over the recipient it displays; post-review recipient swap ⇒ `hash_mismatch`, zero Resend calls. | §1.2, §1.3, §4(2), §7, §10(4) |
| 2 | MEDIUM | A globally-unique `inbound_message_id` caused a cross-project **silent drop**: one client emailing two projects' reply tokens ⇒ Cloudflare invokes the Worker once per recipient with the SAME Message-ID; project A wins, project B hits `ON CONFLICT DO NOTHING` ⇒ 2xx ⇒ Worker does not forward ⇒ message reaches neither project B nor the human fallback. *Verified: 8a dedupe is single-column `onConflictDoNothing({ target: messageId })`, `inbound-inquiry.ts:527-544`.* | Dedupe scoped to the thread: composite **`(project_id, inbound_message_id)`** unique index + `ON CONFLICT(project_id, inbound_message_id) DO NOTHING`; mirrored in schema.ts / client.ts / studio-canon.test.ts. Same Message-ID to same project = idempotent no-op; to two projects = appends to both. | §5, §2.3(5), §3.5, §7, §10(1,7) |
| 3 | LOW | `${subject}\n\n${body}` concatenation is ambiguous — a newline-bearing subject (`cleanText` only trims) can collide with a differently-split subject/body. | Unambiguous per-component encoding: `sha256Hex(sha256Hex(subject)+sha256Hex(body)+sha256Hex(recipient))` (also carries Finding 1's recipient binding). Strip newlines from the email subject at create/update time, not only at send. | §1.2 |
| 4 | LOW | "A stolen token cannot flood a thread" wasn't delivered by global+per-domain caps — a token holder rotating sender domains drives ~200 rows/hr into one thread until the global cap trips (also choking legitimate intake). *Verified: `isRateLimited` is global+per-domain only, `inbound-inquiry.ts:469-481`.* | Added a per-`projectId` hourly cap (e.g. 25) alongside global + per-domain. | §2.3(4), §3.2, §7, §10(7) |
| B1 | build | Token extraction robustness. | Strict anchored, case-sensitive `/^reply\+([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/` on the **envelope** recipient (`message.to`), lowercasing only the domain; non-match ⇒ non-attach ⇒ forward. | §2.3(1) |
| B2 | build | base64url decode correctness. | Verify decodes idPart to a **lowercase** UUID (matching `crypto.randomUUID()`) and computes HMAC over the DECODED projectId bytes, never the raw idPart string. | §2.2 |
| B3 | build | Fail-closed mint bounced. | When `REPLY_TOKEN_SECRET` unset, `mintProjectReplyToken` returns `null` and outbound omits `reply_to` ENTIRELY (no empty-tag bouncing address). | §1.5, §2.2, §3.7 |
| B4 | build | Rate-limit bucket sizing. | Inbound project mail is one-Worker concentrated egress (the `twilioWebhook` lesson) ⇒ use a dedicated generous `rateLimitKind`, not the shared `publicMutation` 20/300s; over-cap failure mode is forward-to-human (throughput, not safety). | §3.6, §10(8) |
| B5 | build | Migration-ordering rationale. | The binding reason 0092 must precede the app deploy is the ALWAYS-ON project-page column read (Drizzle selects `inboundMessageId` on every load ⇒ un-migrated D1 500s every project page), stronger than the append-path reason; keep migrate-first. | §5, §10(1) |
| B6 | build | Clamp completeness. | Widen the agent send-clamp to `channel === "sms" || channel === "email"` in BOTH create (`:170`) and update (`:233-236`); the update clamp keys off `nextChannel` so a re-channel-in-one-patch (`note`→`email`+`sent`) is caught. Guard test: hostile create/update email-sent ⇒ `draft`, zero Resend calls. | §8, §7, §10(4) |
| B7 | build | Runtime for verify. | `node:crypto` (`createHmac` + `timingSafeEqual`) in the Node-runtime endpoint; the WebCrypto constraint is edge-middleware-only — keep verification in the endpoint, not the Email Worker. | §2.2 |
