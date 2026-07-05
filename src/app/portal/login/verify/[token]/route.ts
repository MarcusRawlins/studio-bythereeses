import { consumePortalMagicLink, peekPortalMagicLink } from "@/lib/portal";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Security headers for the interstitial: this page carries a bearer token in the
// URL, so keep it out of caches and referrers.
const INTERSTITIAL_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

function interstitialPage(token: string) {
  // The POST to this same path is what consumes the token. A GET (mail-scanner
  // prefetch, SafeLinks/Proofpoint/Mimecast) never consumes.
  const escaped = encodeURIComponent(token);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Continue to your portal</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8f6f3; color: #222; font-family: Arial, sans-serif; }
    main { width: min(460px, calc(100vw - 40px)); border: 1px solid #d5d0c8; background: #fffdfa; padding: 36px; box-shadow: 0 8px 20px rgb(0 0 0 / 0.05); }
    h1 { font-family: Georgia, serif; font-size: 26px; font-weight: 400; margin: 0 0 12px; }
    p { color: #6f665b; line-height: 1.6; margin: 0 0 24px; }
    button { display: inline-flex; justify-content: center; width: 100%; box-sizing: border-box; border: 1px solid #222; background: #222; color: #f8f6f3; padding: 13px 16px; font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>You're almost in</h1>
    <p>Click the button below to open your secure client portal. This link can be used once.</p>
    <form method="POST" action="/portal/login/verify/${escaped}">
      <button type="submit">Continue to your portal</button>
    </form>
  </main>
</body>
</html>`;
}

// When the feature is flagged OFF, the whole request/verify flow is disabled
// instantly (spec §8 rollback): any outstanding magic link within its TTL must
// no longer be redeemable. Both handlers then behave as if the token were dead —
// the same clean expired redirect — and never touch D1. Kept consistent with
// the request-link route's flag gate.
function magicLinkEnabled() {
  return process.env.PORTAL_MAGIC_LINK_ENABLED === "1";
}

// [N2] GET does NOT consume — it validates liveness and renders a continue
// interstitial. Mail scanners fetch the GET harmlessly; the human's click POSTs.
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!magicLinkEnabled()) {
    redirect("/portal/login?error=expired");
  }
  const peek = await peekPortalMagicLink(token);
  if (!peek.ok) {
    redirect("/portal/login?error=expired");
  }
  return new Response(interstitialPage(token), { headers: INTERSTITIAL_HEADERS });
}

// POST runs the atomic single-use claim, establishes the 30-day session, and
// redirects to /portal. Reuse / expiry / double-click → clean expired page with
// no differentiation between expired, consumed, or unknown.
export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!magicLinkEnabled()) {
    redirect("/portal/login?error=expired");
  }
  const result = await consumePortalMagicLink(token);
  redirect(result.ok ? "/portal" : "/portal/login?error=expired");
}
