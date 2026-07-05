import { db } from "@/db/client";
import { emailSuppressions, projectCommunications } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe-token";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs"; // node:crypto (HMAC verify) + D1
export const dynamic = "force-dynamic";

const PURPOSE = "sequences";

function tokenFrom(request: NextRequest): string | null {
  return new URL(request.url).searchParams.get("t");
}

function badToken() {
  // Fail closed on a bad/absent token. Uniform 400 for both GET and POST.
  return new NextResponse("This unsubscribe link is invalid or has expired.", {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// GET renders a CONFIRM PAGE ONLY — it writes NOTHING. Many mail clients /
// security scanners PREFETCH links in email; a GET that suppressed would let a
// scanner opt a client out without their intent. The confirm button issues the
// POST (and the RFC 8058 List-Unsubscribe-Post one-click also targets the POST).
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const token = tokenFrom(request);
  const verified = verifyUnsubscribeToken(token, PURPOSE);
  if (!verified) return badToken();

  const safeToken = escapeHtml(token ?? "");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="robots" content="noindex" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Unsubscribe — The Reeses Studio</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 3rem 1.5rem; color: #2b2620; background: #fbf9f5; }
  .card { max-width: 30rem; margin: 0 auto; background: #fff; border: 1px solid #e7e1d6; border-radius: 12px; padding: 2rem; }
  h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
  p { line-height: 1.5; }
  button { margin-top: 1rem; padding: 0.7rem 1.3rem; border: 0; border-radius: 8px; background: #2b2620; color: #fff; font-size: 1rem; cursor: pointer; }
</style>
</head>
<body>
  <div class="card">
    <h1>Unsubscribe from automated emails</h1>
    <p>Confirm below to stop receiving automated reminder emails from The Reeses Studio. You'll still receive essential messages about your bookings.</p>
    <form method="post" action="/api/email/unsubscribe?t=${encodeURIComponent(safeToken)}">
      <input type="hidden" name="List-Unsubscribe" value="One-Click" />
      <button type="submit">Confirm unsubscribe</button>
    </form>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Only POST WRITES. Verify the token (fail closed 400; constant-time inside
// verifyUnsubscribeToken), then INSERT ... ON CONFLICT DO NOTHING into
// email_suppressions (idempotent; attacker-chosen input → insert-not-update),
// and VOID open sequence email drafts for that recipient (close the queued-draft
// window). Even a replayed/forged POST can only ever SUPPRESS (fail-safe
// direction), and the token binds the email so one client cannot unsubscribe
// another. Neutral 200 (uniform, no enumeration).
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const token = tokenFrom(request);
  const verified = verifyUnsubscribeToken(token, PURPOSE);
  if (!verified) return badToken();

  const email = verified.email;
  const now = new Date().toISOString();

  await db
    .insert(emailSuppressions)
    .values({ email, suppressedAt: now, source: "unsubscribe_link", note: null })
    .onConflictDoNothing();

  // Void open sequence email drafts for this recipient so an already-queued draft
  // cannot be sent post-unsubscribe. Only sequence_step drafts are touched;
  // hand-written admin drafts are left alone.
  const voided = await db
    .update(projectCommunications)
    .set({ status: "archived", updatedAt: now })
    .where(
      and(
        eq(projectCommunications.channel, "email"),
        eq(projectCommunications.status, "draft"),
        eq(projectCommunications.sourceType, "sequence_step"),
        sql`lower(${projectCommunications.recipientEmail}) = ${email}`,
      ),
    )
    .returning({ id: projectCommunications.id });

  await logActivity({
    action: "email.unsubscribed",
    actorType: "client",
    actorName: "Client unsubscribe",
    metadata: { source: "unsubscribe_link", voidedDrafts: voided.length },
  });
  if (voided.length > 0) {
    await logActivity({
      action: "sequence.draft_voided_on_unsubscribe",
      actorType: "client",
      actorName: "Client unsubscribe",
      metadata: { count: voided.length },
    });
  }

  return new NextResponse("You've been unsubscribed from automated emails.", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
