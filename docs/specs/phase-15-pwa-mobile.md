# Phase 15 — PWA / Installable Mobile (Admin App)

**Status:** spec / build-ready
**Author:** design-spec agent
**Date:** 2026-07-06
**Runtime ground truth:** Next.js 16.2.10 (App Router) → OpenNext (`@opennextjs/cloudflare` ^1.19.5) → Cloudflare Worker (`.open-next/worker.js`), fronted by the Pages proxy (`pages-proxy/_worker.js`). Static assets served from the Workers Assets binding (`ASSETS` → `.open-next/assets`, populated from `public/` + App-Router metadata files).

---

## 0. Goal & scope

Make **the admin app (`studio.bythereeses.com`) installable and mobile-usable** so Tyler can add it to his iPhone home screen and run the business on location — matching HoneyBook's #1 differentiator at near-zero cost.

**Target surface: the admin app only.** Not `schedule.bythereeses.com` (public booking, single-purpose) and not `/portal` / `/proposal` (per-client token surfaces — installing those as an "app" makes no sense and multiplies the token-leak surface). The manifest, icons, and (later) service worker are scoped to the studio host. The "run my business" job = the admin dashboard on the phone.

**In scope (v1):** web app manifest + icons + theme + `display: standalone` + iOS meta + viewport-fit — a fully installable PWA on iOS Safari **with no service worker**. iOS "Add to Home Screen" requires only the manifest + apple meta tags; a service worker is **not** needed to install on Tyler's iPhone. This is the whole MVP and it is install-complete for the target device.

**Deferred / behind a flag:** service worker (offline app-shell, faster static loads, Android/desktop install prompt) — specced in §3, shipped dark behind `PWA_SERVICE_WORKER`. Web push — specced at a high level in §9, not built in this phase.

**Explicitly NOT in scope:** a mobile redesign of admin pages. The admin UI is already Tailwind-responsive (§8); this phase ships install + shell, not a re-layout.

---

## 1. The security constraint (read this first — it is the whole risk)

A naive service worker that caches HTML or authenticated API responses is a **real data-leak**: it can serve one Google-admin session's private CRM content to a later request, or serve a stale authenticated page *after logout*. The auth model this must not undermine:

- `studio.bythereeses.com` — everything except `isStudioPublicPath(...)` is gated behind the Google admin session (proxy `verifyAdminSession`) **and** a defense-in-depth signed `x-reese-admin-proof` (middleware, under `ADMIN_PROOF_ENFORCE`). Session cookie is `reese_studio_session`, 30-day.
- `/portal`, `/p/`, `/proposal/` — per-client token/session surfaces.
- `schedule.bythereeses.com` — public.

**The non-negotiable caching rule (see §3):** the service worker MUST NEVER cache an HTML document, a navigation response, or any `/api/*` response. It may cache-first ONLY truly-static, non-sensitive, content-addressed assets (hashed `/_next/static/**`, fonts, PWA icons, the manifest). The safest way to guarantee this — adopted here — is a **default-deny caching allowlist**: the fetch handler calls `event.respondWith()` **only** for URLs on an explicit static allowlist; for everything else (documents, APIs, anything not allowlisted) it does **not intercept at all**, so the browser performs its normal credentialed network fetch and the SW can never short-circuit an authed response.

The **manifest + icons alone (v1, no SW) carry essentially zero leak risk**: a web manifest and PNG icons are inert static metadata. They become "an app" only at install time and never intercept a network request. That is why v1 can ship first and the SW ships later behind a flag.

---

## 2. Manifest (v1)

### 2.1 Decision: static file, not `app/manifest.ts`

Ship the manifest as a **static file `public/manifest.webmanifest`**, referenced from `layout.tsx` via `metadata.manifest`.

Rationale over the `app/manifest.ts` route-handler convention (both are valid in Next 16 — see `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/manifest.md`):
- A static file is served straight from the Workers `ASSETS` binding — it is **provably static, cacheable, and non-sensitive**, and slots into the proxy's `isPublicAssetPath` allowlist as an *asset* (§6) with no chance of ever becoming a dynamic/authed route.
- `app/manifest.ts` compiles to a Route Handler (`/manifest.webmanifest`) that runs in the Worker. It would be "cached by default" only until it touches a request-time API, and it adds a dynamic code path where a static file suffices. Avoid.

The manifest has no per-user content, so a static file is strictly correct.

### 2.2 Manifest contents

`public/manifest.webmanifest`:

```json
{
  "id": "/",
  "name": "The Reeses Studio",
  "short_name": "Studio",
  "description": "Private CRM and studio for The Reeses.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#fbf8f2",
  "theme_color": "#fbf8f2",
  "icons": [
    { "src": "/icon.png",                 "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/brand/pwa-192.png",         "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/brand/pwa-512-maskable.png","sizes": "512x512", "type": "image/png", "purpose": "maskable" },
    { "src": "/brand/pwa-192-maskable.png","sizes": "192x192", "type": "image/png", "purpose": "maskable" }
  ]
}
```

Field decisions:
- **`name` / `short_name`** — mirror the existing `metadata.title` ("The Reeses Studio"); `short_name` "Studio" is what shows under the home-screen icon (≤12 chars renders cleanly on iOS).
- **`start_url` / `scope` = `/`** — the dashboard (`src/app/page.tsx`, `force-dynamic`). Launching lands on the dashboard; if the 30-day session has lapsed, the proxy 303s to `/admin/login` — correct behavior, no special handling. Keep `start_url` bare `/` (no query) so it never perturbs the proxy's booking-cache keying (that logic is schedule-host-only anyway, but keep it clean).
- **`id` = `/`** — stable app identity so a future `start_url` change doesn't spawn a duplicate installed app.
- **`display: standalone`** — no browser chrome; the "app" feel and HoneyBook parity.
- **`background_color` / `theme_color` = `#fbf8f2`** — the app's warm cream (`--bg` in `globals.css`). `background_color` paints the splash; `theme_color` tints the Android/desktop title bar to match the app chrome for a seamless look. (Alternative: dark ink `#1c1a17` for a dark title bar — rejected for v1; the app is a light surface and a cream bar reads as intentional.)
- **`orientation`** — **omit.** The CRM has tables/wide finance views that benefit from landscape; do not lock orientation.
- **Icons** — see §2.3. Chrome/Android reads manifest `icons`; iOS ignores them for the home-screen icon and uses the `apple-touch-icon` link instead (§4), so both must be provided.

### 2.3 `layout.tsx` metadata wiring

Extend the existing `metadata` export (currently title/description/icons only) and add a `viewport` export. In Next 16 these emit the correct `<head>` tags automatically:

```ts
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "The Reeses Studio",
  description: "Private CRM and executive assistant studio for The Reeses.",
  manifest: "/manifest.webmanifest",              // <link rel="manifest">
  appleWebApp: {                                   // iOS meta (see §4)
    capable: true,
    title: "Studio",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "64x64" },
      { url: "/icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#fbf8f2",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",                            // notch handling (see §4)
};
```

**Note:** `viewport-fit=cover` overlaps content under the notch/home-indicator. Pair with `env(safe-area-inset-*)` padding on the top-level chrome (`AppShell`) — a small CSS follow-up (§8), not a blocker for install.

### 2.4 Manifest Cache-Control

`/manifest.webmanifest` is static but versionable — serve with a **short** cache so an updated manifest propagates within an hour: `Cache-Control: public, max-age=3600`. See §7 for the OpenNext Workers-Assets header mechanism (a `public/_headers` rule) and the caveat about the default asset cache policy.

---

## 3. Service worker — the make-or-break section (deferred, flag-gated)

**Recommendation: do NOT ship the SW in v1.** Ship manifest-only first (fully installable on iOS). Add the SW in a follow-up, dark behind `PWA_SERVICE_WORKER`, only after the manifest install is validated in production. A stuck/misbehaving SW is far stickier than a manifest (it installs on every visit and can persist across deploys), so it gets its own flag and its own kill switch.

This section fully specifies the SW so the follow-up is build-ready.

### 3.1 File, scope, serving

- File: **`public/sw.js`** → served by the `ASSETS` binding at **`/sw.js`** (root scope). Root scope is required so the SW can control the whole origin; a SW served from a subpath can only control that subpath.
- Serve `/sw.js` with **`Cache-Control: no-cache`** (or `max-age=0, must-revalidate`) via `public/_headers` (§7). Browsers already bypass the HTTP cache for the SW script on update checks (bounded to 24h), but an intermediary/CDN cache pinning `sw.js` would delay a kill-switch swap — `no-cache` closes that gap.
- Content-Type must be `application/javascript` (Workers Assets sets this from the `.js` extension).

### 3.2 Registration — runtime-flippable, three-state

Registration is **gated at request time** (not `NEXT_PUBLIC_*`, which bakes in at build and can't be rolled back without a rebuild). `layout.tsx` is a server component running in the Worker; read `process.env.PWA_SERVICE_WORKER` per request and render one of three tiny inline scripts:

| `PWA_SERVICE_WORKER` | Behavior |
|---|---|
| unset / `"off"` (default) | **Kill switch.** Render an *unregister* script: `navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()))` **and** `caches.keys().then(ks => ks.forEach(k => caches.delete(k)))`. Guarantees any previously-installed SW is torn down and its cache purged. Zero SW active. |
| `"register"` | Register `/sw.js` (`navigator.serviceWorker.register("/sw.js", { scope: "/" })`) after `load`. |
| `"enforce"` (optional, later) | Same as `register`; reserved if we later want to require the SW for an offline shell. |

Default-off + active-unregister mirrors the M4 / CSP three-state pattern and gives an **instant remote kill**: `wrangler secret delete PWA_SERVICE_WORKER` (or set `off`) → next navigation tears the SW down. This is the single most important safety property of the whole phase.

**CSP compatibility of the inline registration script:** under `CSP_MODE=enforce`, `script-src` is `'self' 'nonce-{nonce}' 'strict-dynamic'` — an unnonced inline script is blocked. The registration `<script>` MUST carry the per-request nonce (read from the `x-nonce` request header the middleware sets; see `src/middleware.ts` / `src/lib/csp.ts`). Because `layout.tsx` renders on every eligible document route, it already has access to the nonce via `headers()`. Emit `<script nonce={nonce}>…</script>`. Under `CSP_MODE=off`/`report` (today's default), no nonce is required. **Build note:** verify the registration script renders with the nonce under enforce before flipping either flag.

**Host-scoping (binding, from §0):** SW registration MUST be emitted ONLY on the studio host (`studio.bythereeses.com`) — never on `schedule.bythereeses.com` or the `/portal` / `/p/` / `/proposal/` token surfaces. `layout.tsx` is the shared root layout for every host, so the registration script has to be conditioned on the request host (the SW's scope, manifest, and install target are all studio-only). Emitting it on the schedule/booking host would register a whole-origin SW on a surface that must stay a plain public network fetch.

**Dynamic-rendering caveat (binding):** reading `headers()` (for the nonce or the host) inside the root `layout.tsx` opts every route rendered through it into **dynamic rendering** — including the proxy-cached booking pages (`/book/*`), which today render without an app CSP precisely so the proxy can cache their HTML without freezing a nonce (see `applyAppCsp` in `pages-proxy/_worker.js`). The registration script must therefore be introduced in a way that does NOT force `/book/*` (or any currently-static/cacheable route) dynamic and must NOT break enforce-mode CSP: gate the `headers()` read behind the studio-host + flag-on condition (e.g. resolve the host/nonce in middleware and pass via a header consumed only on studio routes), so booking pages keep their static, nonce-free, proxy-cacheable rendering. Validate the `/book/*` cache path and the enforce-mode nonce together before flipping `PWA_SERVICE_WORKER`.

### 3.3 Caching policy — DEFAULT-DENY ALLOWLIST (the core)

The fetch handler intercepts **only** same-origin `GET` requests whose URL matches the static allowlist. Everything else is left entirely to the browser (no `respondWith`), so no document/API/credentialed response is ever inspected, stored, or served by the SW.

**CACHEABLE — cache-first, immutable (the ONLY things the SW ever stores):**

| Pattern | Why safe | Strategy |
|---|---|---|
| `/_next/static/**` | content-hashed, immutable, identical for all users | cache-first, long-lived |
| `/fonts/**` (`.woff`, `.woff2`) | static brand fonts, non-sensitive | cache-first |
| `/brand/**` (PWA icons, logos) | static, non-sensitive | cache-first |
| `/icon.png`, `/apple-icon.png`, `/favicon.ico` | static app icons | cache-first |
| `/manifest.webmanifest` | static, non-sensitive | stale-while-revalidate (or network-first — it's tiny) |

**NEVER CACHE / NEVER INTERCEPT (the hard rule — no `respondWith`, no `cache.put`, ever):**

- **Any navigation request** — `request.mode === "navigate"`, OR `Accept` contains `text/html`. These are authed admin HTML. *Regardless of path.*
- **Any `/api/*`** request — authed JSON (or token/webhook surfaces).
- **`/admin/*`, `/portal/*`, `/p/*`, `/proposal/*`** — session/token surfaces (already covered by "navigation + api", but enumerated explicitly for the reviewer and for defense in depth).
- **Any non-`GET`** request.
- **Any cross-origin** request (only `self.location.origin` is even considered).
- **Any allowlisted path that fails strict path hygiene** — the allowlist predicate rejects any pathname containing `%` or `..` (equivalently, matches only a strict `[A-Za-z0-9/._-]` charset). This is the real, implementable guard: it prevents an encoded-traversal or dot-segment URL (`/brand/%2e%2e/…`, `/_next/static/../…`) from ever being intercepted-and-cached, closing the only path-based attack the SW can actually see. *(Corrected: a SW **cannot** read the `Cookie` request header — it is a [forbidden header name](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name) and reads as `null`, so a "reject credentialed requests" guard is unimplementable. It would also be **wrong**: the session cookie is `Path=/`, so it IS sent to `/brand/*` and other allowlisted static paths — those paths are NOT cookieless. Path hygiene replaces that dead guard.)*
- **Any response that is not `status === 200` + `response.type === "basic"`**, or that carries `Cache-Control: private` or `Cache-Control: no-store` — never store it (guards against a static path unexpectedly returning a personalized/error response). *(Corrected: a `Set-Cookie` response guard is dropped — `Set-Cookie` is never exposed to `fetch`/SW `Response` objects, so it can never be read and the guard is unimplementable.)*

Because documents and APIs are **never intercepted**, the fetch handler's default branch is simply "return" (fall through to browser). It cannot serve a cached authed page, cannot serve a logged-out user a cached logged-in page, and cannot cross session boundaries. That is the entire data-leak defense, and it is structural, not incidental.

### 3.4 Versioned cache + lifecycle

- Cache name: **`reese-pwa-static-v1`** (bump the integer on any policy change).
- `install`: optionally pre-cache the static allowlist for the icons/fonts/manifest (never any HTML). `self.skipWaiting()` acceptable.
- `activate`: **delete every cache whose name ≠ the current version**, then `self.clients.claim()`. A version bump therefore evicts all prior entries — this is how a policy change or a "purge everything" is enforced.
- Hashed `/_next/static/**` is content-addressed, so a deploy produces new URLs and the SW naturally fetches-and-caches the new chunks; stale old chunks are evicted on the next version bump. **No risk of serving stale JS/CSS across a deploy** because URLs change with content.

### 3.5 Logout / session-change safety

Because the SW **never caches any authenticated content**, there is nothing session-scoped to invalidate on logout — the next post-logout navigation is a normal network fetch that the proxy 303s to `/admin/login`. No SW code path can return a pre-logout page.

Belt-and-suspenders (optional, cheap): the `off` kill-switch script (§3.2) already purges all caches; additionally, a `message`-triggered `caches.delete()` can be posted from the app on `/admin/logout`. Not required for correctness — documented so a reviewer sees it was considered and deemed unnecessary given the default-deny policy.

### 3.6 No offline authenticated shell (v1 of the SW)

An offline app-shell that serves a cached HTML page is a **document** — the exact thing §3.3 forbids. If we ever add an offline shell, it MUST be a **generic, unauthenticated, content-free** shell (e.g. a static `/offline.html` with brand + "You're offline" + no CRM data), served ONLY as the `navigate` fallback when the network is unreachable, and NEVER a real admin page. This is deferred; do not build it in the first SW drop.

---

## 4. iOS / Safari specifics (Tyler is on iPhone)

iOS Safari does NOT read the web manifest for the home-screen icon or standalone behavior the way Android does — it uses legacy `apple-*` meta + the `apple-touch-icon` link. All of these are emitted by the `layout.tsx` metadata in §2.3:

- **`apple-touch-icon`** — emitted from `src/app/apple-icon.png` (existing, 180×180) by Next's App-Router icon convention. This is the iOS home-screen icon. iOS has no maskable concept; it rounds the square itself, so ensure the 180×180 has no transparent corners it relies on (the existing `apple-icon.png` is fine; note iOS ignores alpha and composites on black/white).
- **`apple-mobile-web-app-capable` = yes** — from `metadata.appleWebApp.capable: true`. Enables standalone (no Safari chrome) when launched from the home screen.
- **`apple-mobile-web-app-status-bar-style` = default** — from `statusBarStyle: "default"`. `default` = normal status bar (dark text) over the cream app; matches `theme_color`. (`black-translucent` would let content flow under the status bar — only worth it with careful safe-area padding; not for v1.)
- **`apple-mobile-web-app-title` = "Studio"** — from `appleWebApp.title`; the home-screen label on iOS.
- **`viewport-fit=cover`** (§2.3 `viewport`) — required so the app fills the screen including the notch/Dynamic Island area. Pair with `padding: env(safe-area-inset-top/bottom/left/right)` on the `AppShell` header/footer so nothing hides under the notch or home indicator. This CSS pairing is the one iOS follow-up worth doing alongside install (§8); without it the app still installs and works, it just may sit slightly under the notch.

**iOS install path:** Share → Add to Home Screen. Works with **manifest + apple meta only, no service worker.** This is why v1 (manifest-only) is genuinely install-complete for Tyler's phone.

---

## 5. Off-by-default / rollout

| Layer | Ships in | Flag | Default | Rollback |
|---|---|---|---|---|
| Manifest + icons + iOS meta + viewport | **v1 (this phase)** | none needed — inert static metadata, harmless until a user chooses "install" | always on | remove `metadata.manifest` / the files; installed users keep a stale icon that simply reloads the site |
| Service worker | follow-up | **`PWA_SERVICE_WORKER`** (off / register / enforce) | **off** (renders unregister/kill script) | `wrangler secret delete PWA_SERVICE_WORKER` → next visit unregisters + purges caches |

The manifest carries no runtime behavior change (no interception, no caching) — it is safe to ship without a flag, consistent with "off-by-default flag for any *runtime change*"; a manifest is not a runtime change. The SW **is** a runtime change and gets the flag + kill switch per the Active-Learning-Log rule.

---

## 6. Proxy / auth allowlist (exact entries)

The manifest and SW file must load **unauthenticated** on `studio.bythereeses.com` (a login-walled manifest = broken install), WITHOUT widening any sensitive path.

### 6.1 Proxy (`pages-proxy/_worker.js` → `isPublicAssetPath`)

Add two exact-match entries:

```js
function isPublicAssetPath(pathname) {
  return (
    pathname === "/favicon.ico" ||
    pathname === "/icon.png" ||
    pathname === "/apple-icon.png" ||
    pathname === "/manifest.webmanifest" ||   // Phase 15: PWA manifest (static, non-sensitive)
    pathname === "/sw.js" ||                   // Phase 15: service worker (static; add now, file lands with the SW drop)
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/brand/") ||
    pathname.startsWith("/fonts/")
  );
}
```

- **Icons need NO new entry.** The 192/maskable PWA icons live under `public/brand/` (already allowlisted via `/brand/`); `/icon.png`, `/apple-icon.png`, `/favicon.ico` are already allowlisted. This deliberately keeps the new allowlist surface to exactly two static, non-sensitive files.
- `isPublicAssetPath` is also consumed by `isSchedulePublicPath` — so the manifest/sw also become public on the schedule host. Harmless (both are static, non-sensitive) and irrelevant (we don't advertise the manifest there).
- These are exact-match, non-sensitive static files. They do **not** widen any dynamic/authed path.

### 6.2 App classifier (`src/lib/admin-proxy-auth.ts` → `isStaticAssetPath`) — keep the drift test green

`adminProofRequired` treats `isStaticAssetPath` paths as non-admin (no proof). Add the same two entries so the classifier stays in lockstep with the proxy (the drift test `src/lib/admin-surface-classification.test.ts` pins these two predicates against each other):

```ts
function isStaticAssetPath(path: string): boolean {
  return (
    path === "/favicon.ico" ||
    path === "/icon.png" ||
    path === "/apple-icon.png" ||
    path === "/manifest.webmanifest" ||   // Phase 15
    path === "/sw.js" ||                    // Phase 15
    path.startsWith("/_next/static/") ||
    path.startsWith("/_next/image") ||
    path.startsWith("/brand/") ||
    path.startsWith("/fonts/")
  );
}
```

Then add `/manifest.webmanifest` and `/sw.js` to the `studioPublic` array in `admin-surface-classification.test.ts` so both classifications are pinned (a future edit dropping either fails loudly).

### 6.3 Middleware matcher — already excludes them (confirm, no change)

`src/middleware.ts` `config.matcher` negative-lookahead `…|.*\\..*).*` excludes any path containing a dot. **`/manifest.webmanifest` and `/sw.js` both contain a dot → middleware never runs for them.** Consequences (all desirable):
- No CSP nonce injection into the manifest/sw (correct — they're not nonce-eligible documents).
- `guardDirectWorkerPageRequest` (origin-guard) never runs for them — but they're served by the `ASSETS` binding as static files, not by an origin-guarded dynamic route, so this is fine.

### 6.4 Origin-guard bypass lists — ZERO changes (explicit non-widening)

Do **NOT** add `/manifest.webmanifest` or `/sw.js` to `PUBLIC_PAGE_PREFIXES` / `PUBLIC_API_PREFIXES` in `src/lib/origin-guard.ts`. Those lists exempt **dynamic public routes** from the direct-`*.workers.dev` block. The manifest/sw are static assets excluded from middleware entirely (§6.3), so they need no bypass entry, and adding one would needlessly widen the sensitive direct-origin bypass surface. This satisfies the Active-Learning-Log rule "do NOT add … to origin-guard bypass lists."

---

## 7. OpenNext / Cloudflare static-serving caveats

- **Root-scope SW is fine.** `public/sw.js` is emitted to `.open-next/assets/sw.js` and served by the `ASSETS` binding at `/sw.js` (root) — the scope a whole-origin SW needs. No OpenNext limitation here.
- **Per-file Cache-Control** is the one thing to pin. Workers Assets applies a default cache policy; `/_next/static/**` gets long immutable caching automatically, but `public/` files (manifest, sw) may inherit a default that's wrong for `sw.js` (which must be `no-cache`) and suboptimal for the manifest. **Use a `public/_headers` file** (Cloudflare Workers static-assets supports `_headers` rules) to pin:
  ```
  /sw.js
    Cache-Control: no-cache
  /manifest.webmanifest
    Cache-Control: public, max-age=3600
  ```
  **Build task:** verify the deployed `Cache-Control` on both files with `curl -sI` after deploy (the `_headers` support + exact default must be confirmed against the installed OpenNext/Wrangler versions; if `_headers` is not honored for Workers Assets in this setup, fall back to serving `sw.js`/manifest via a tiny static-headers route — but prefer `_headers`).
- **App-Router metadata files** (`app/icon.png`, `app/apple-icon.png`, `app/favicon.ico`) are already served correctly today (referenced by the current `metadata.icons`); the manifest link + new PWA `/brand/*` icons ride the same asset pipeline.
- **`images.unoptimized: true`** (`next.config.ts`) means there is no `/_next/image` optimizer route to worry about in the SW allowlist — good; the SW allowlist deliberately omits `/_next/image`.

---

## 8. CSP compatibility

Today's enforced baseline (proxy `SECURITY_HEADERS` + `src/lib/csp.ts` `CSP_BASELINE_DIRECTIVES`) is:
`base-uri 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests` — **no `default-src`, no `manifest-src`, no `worker-src`**.

- **Manifest:** with no `default-src` and no `manifest-src`, the `<link rel="manifest">` fetch is unrestricted by CSP. **No CSP change required for v1.**
- **Service worker:** with no `default-src` and no `worker-src`/`child-src`, registering a same-origin `/sw.js` is unrestricted. **No CSP change required** for the SW either.
- **Future-proofing:** if a `default-src` is ever introduced, it would start restricting these — at that point add `manifest-src 'self'` and `worker-src 'self'` to `CSP_BASELINE_DIRECTIVES`. Note this in `src/lib/csp.ts` so the coupling is discoverable.
- **The one live CSP interaction** is the inline SW-registration `<script>` under `CSP_MODE=enforce` — it must carry the nonce (§3.2). This only matters when both `PWA_SERVICE_WORKER=register` AND `CSP_MODE=enforce` are on; validate that combination before flipping.

---

## 9. Web push (deferred — high-level only)

Not built this phase. When specced: requires the SW (a `push` + `notificationclick` handler), a VAPID keypair (public key inlined, private key as a Worker secret), a `PushSubscription` persisted per-device in D1, and a send path from the CRM. iOS supports web push **only for an installed (Add-to-Home-Screen) PWA** on iOS 16.4+ — so it depends on this phase's install working first. Gate behind its own flag. Out of scope for the build.

---

## 10. Mobile UX / scope check

The admin UI is Tailwind-based and already broadly responsive (`AppShell` + utility classes). This phase does **not** re-layout admin pages. Two small, in-scope CSS touch-ups directly tied to install quality:
1. **Safe-area padding** on `AppShell` chrome to pair with `viewport-fit=cover` (§4) so nothing hides under the iPhone notch/home indicator.
2. Confirm the standalone view has no dependency on browser chrome (e.g. no "use the back button" affordance) — spot-check the primary nav works within `display: standalone`.

**Follow-up (NOT this phase):** audit data-dense pages — Finance tables, the invoice/proposal editors — for horizontal overflow on a 390px-wide viewport, and note any that need a responsive pass. Capture findings as a Phase-15b backlog item; do not expand this phase into a redesign.

---

## 11. Test plan

Grounded in the repo's harness: `npm run build` (exit-code gate), `node scripts/run-tests.mjs` (tsx tests), and targeted `tsx` asserts. **Gate on the build EXIT CODE, not on "Compiled successfully"** — a type error prints `Failed to type check` and exits 1 *after* "Compiled successfully" (Active-Learning-Log).

**A. Build / typecheck**
- `npm run build` exits `0`. (New `Viewport` import + metadata typed correctly; no TS2559 weak-type default-param patterns introduced.)

**B. Classifier drift (extend `src/lib/admin-surface-classification.test.ts`)**
- Add `/manifest.webmanifest` and `/sw.js` to `studioPublic`; assert for each: `isStudioPublicPath(p) === true` AND `adminProofRequired(p) === false`.
- Assert `isPublicAssetPath("/manifest.webmanifest") === true`, `isPublicAssetPath("/sw.js") === true`.
- Assert origin-guard is **unchanged**: `isPublicOriginBypassPath("/manifest.webmanifest") === false` and `isPublicOriginBypassApiPath("/sw.js") === false` (proves we did NOT widen the direct-origin bypass).

**C. Service-worker caching policy (unit-test the classifier before the SW ships)** — extract the SW's cache-eligibility decision into a pure, importable predicate (e.g. `isPwaCacheable(url, request)` in a testable module the SW imports) and assert, via `tsx`:
- Cacheable → `true`: `/_next/static/chunk-abc.js`, `/fonts/times-now-light.woff`, `/brand/pwa-192.png`, `/icon.png`, `/apple-icon.png`, `/favicon.ico`, `/manifest.webmanifest` (all GET, same-origin).
- **Never cacheable → `false` (the data-leak asserts — these are load-bearing):**
  - a navigation/document request (`Accept: text/html` or `mode: navigate`) to `/`, `/clients`, `/finance` — **false** for every one.
  - any `/api/*` (`/api/agent/projects`, `/api/proposal/x/accept`, `/api/scheduler/bookings`) — **false**.
  - `/admin/login`, `/portal/x`, `/p/tok`, `/proposal/tok` — **false**.
  - a non-GET to an allowlisted path (`POST /_next/static/x`) — **false**.
  - a cross-origin GET to an allowlisted-looking path — **false**.
  - a GET to an allowlisted-looking path that fails strict path hygiene — **false**: `/brand/%2e%2e/secret.png`, `/_next/static/../x`, any pathname containing `%` or `..` (encoded-traversal / dot-segment). This is the implementable path guard.
- Assert the response-side guard: a `200` `basic` response carrying `Cache-Control: private` or `Cache-Control: no-store` is **not** stored. *(Removed the former `Cookie`-request and `Set-Cookie`-response asserts: both would pass against a Node predicate while validating browser behavior that cannot exist — a SW cannot read `Cookie` (forbidden header) or `Set-Cookie` (never exposed to JS) — i.e. false assurance.)*

**D. Manifest reachable unauthenticated (production smoke — extend `scripts/production-smoke.mjs`)**
- `GET https://studio.bythereeses.com/manifest.webmanifest` with **no session cookie** → `200`, `content-type` JSON/manifest, body parses, `start_url === "/"`. (A `303 → /admin/login` here = FAIL: the manifest is login-walled and install is broken.)
- `GET https://studio.bythereeses.com/sw.js` (once shipped) no cookie → `200`, `content-type: application/javascript`, `Cache-Control: no-cache`.
- Regression: `GET https://studio.bythereeses.com/clients` no cookie still `303 → /admin/login` (proves the allowlist additions did NOT open a dynamic admin path).

**E. Kill switch (once SW ships)**
- With `PWA_SERVICE_WORKER=off`, the rendered document contains the unregister+cache-purge script (assert HTML contains the unregister call). With `=register`, it contains `serviceWorker.register("/sw.js"`.

**F. CSP interaction**
- With `CSP_MODE=enforce`, the SW-registration inline `<script>` carries a `nonce` matching the response CSP header (assert the nonce attribute is present and non-empty). Skipped/N/A when SW flag is off.

**G. Manual install verification (release checklist, not automated)**
- iPhone Safari → Add to Home Screen → icon = the AT badge, label = "Studio", launches standalone (no Safari chrome), status bar legible, no content under the notch, dashboard loads. Log out on another device → relaunch installed app → lands on `/admin/login` (no stale authed page).

---

## 12. Ordered task breakdown (effort / risk)

**v1 — manifest-only, fully installable (ship first):**

1. **Add `public/manifest.webmanifest`** (§2.2). — *Effort: XS. Risk: none (inert static).*
2. **Generate PWA icons** into `public/brand/`: `pwa-192.png` (192, `any`, downscale from `src/app/icon.png`), `pwa-512-maskable.png` + `pwa-192-maskable.png` (maskable — AT monogram from `public/brand/at-badge-dark.png`, centered on a solid `#fbf8f2` field with ≥10% safe-zone padding so the maskable crop never clips the mark). Reuse existing `src/app/icon.png` (512) and `src/app/apple-icon.png` (180). — *Effort: S. Risk: low (visual only).*
3. **Wire `layout.tsx`**: add `manifest`, `appleWebApp`, and the `viewport` export (§2.3). — *Effort: XS. Risk: low.*
4. **Proxy allowlist**: add `/manifest.webmanifest` (+ `/sw.js` now, harmless before the file exists) to `isPublicAssetPath` (§6.1). — *Effort: XS. Risk: MEDIUM — this is an auth-surface edit; review against the live proxy/origin-guard/admin-proof boundary. Mitigated: exact-match static files, no dynamic widening.*
5. **Classifier lockstep**: add the same two to `isStaticAssetPath` and to the drift test's `studioPublic` (§6.2, §11B). — *Effort: XS. Risk: low (keeps drift test green).*
6. **`public/_headers`**: pin `Cache-Control` for manifest (and sw). Verify support against installed OpenNext/Wrangler; fall back if unsupported (§7). — *Effort: S. Risk: low.*
7. **Safe-area CSS** on `AppShell` for `viewport-fit=cover` (§4, §10). — *Effort: S. Risk: low.*
8. **Tests**: build exit-code, drift asserts (B), manifest-unauth smoke + `/clients` regression (D). — *Effort: S. Risk: low.*
9. **Deploy** via the standard rails (D1 backup → capture rollback version → deploy origin + `deploy:pages-proxy` → health-check headers/redirects → rollback on fail). Both the app Worker AND the Pages proxy must deploy (the allowlist lives in the proxy). — *Effort: S. Risk: MEDIUM (two-Worker deploy; proxy edit).*

**Follow-up — service worker (dark, flagged):**

10. **`public/sw.js`** implementing the default-deny allowlist + versioned cache + activate cleanup (§3.3–3.4), with the cache-eligibility decision in an importable, testable predicate. — *Effort: M. Risk: HIGH (the leak surface) — mitigated by default-deny + the §11C asserts.*
11. **Runtime-flippable registration** in `layout.tsx` reading `PWA_SERVICE_WORKER` (off/register), with the nonce on the inline script (§3.2). — *Effort: S. Risk: MEDIUM (CSP nonce; kill-switch correctness).*
12. **`_headers` `no-cache` for `/sw.js`** verified via `curl -sI` post-deploy (§7). — *Effort: XS. Risk: low.*
13. **SW tests**: §11C (cache policy asserts), §11E (kill switch), §11F (CSP nonce), §11D (`/sw.js` unauth 200). — *Effort: M. Risk: low.*
14. **Rollout**: deploy with `PWA_SERVICE_WORKER` unset (kill script active) → set `register` in a preview/one device → validate no authed content is ever served from cache (DevTools → Application → Cache Storage shows ONLY static allowlist entries; Network shows documents/API always from network) → enable in prod. Instant rollback = delete the secret. — *Effort: S. Risk: MEDIUM.*

---

## 13. Active-Learning-Log pre-emption (checklist)

- **Off-by-default flag for the runtime change:** SW behind `PWA_SERVICE_WORKER` (default off = active kill/unregister); manifest is inert metadata, no flag needed. ✔
- **No widening of sensitive bypass lists:** manifest/sw added ONLY to the static-asset allowlists (`isPublicAssetPath`/`isStaticAssetPath`), NOT to origin-guard `PUBLIC_*_PREFIXES`; asserted in the drift test. ✔
- **Classifier drift:** proxy `isPublicAssetPath` and app `isStaticAssetPath` updated in lockstep and pinned by `admin-surface-classification.test.ts`. ✔
- **Workers/OpenNext static-serving:** root-scope `/sw.js` served by `ASSETS`; per-file `Cache-Control` pinned via `_headers` and verified with `curl -sI` (default asset cache confirmed, not assumed). ✔
- **CSP compatibility:** no `default-src` today → manifest/SW unrestricted; nonce required on the inline registration script under `CSP_MODE=enforce`; `manifest-src`/`worker-src 'self'` noted for the day a `default-src` lands. ✔
- **Build-exit-code gate:** CI gates on `npm run build` exit `0`, not on a success phrase; no weak-type default-param env reads introduced. ✔
- **Proxy composition:** the manifest is verified reachable unauthenticated end-to-end through the LIVE proxy (production smoke asserts `200`, not a `303 → /admin/login`), and the `/clients` regression proves no dynamic admin path was opened. ✔
- **Data-leak (the core):** default-deny SW allowlist — documents and `/api/*` are never intercepted or cached, so no cross-session/post-logout authed content can be served; asserted directly in §11C. ✔
```
