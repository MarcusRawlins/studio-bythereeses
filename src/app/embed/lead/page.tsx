import { isLeadFormEnabled } from "@/lib/inbound-inquiry";
import { getLeadFormConfig } from "@/lib/lead-form";
import { mintFormNonce, verifyLeadFormEmbedToken } from "@/lib/lead-form-links";
import { notFound } from "next/navigation";
import { LeadFormBody } from "./LeadFormBody";

// MAJOR-2: force-dynamic so Next NEVER full-route-caches this page. A cached page would freeze one
// { issuedAtMs, id } nonce for every visitor → after MAX_AGE_MS every submit is silently dropped,
// and within the window two visitors share one nonceId → dedup collision drops the second lead. The
// proxy additionally stamps `cache-control: private, no-store` on this exact path (see _worker.js).
export const dynamic = "force-dynamic";

export default async function LeadFormEmbedPage({
  searchParams,
}: {
  searchParams?: Promise<{ t?: string; error?: string }>;
}) {
  // I1: flag OFF ⇒ no surface. Checked BEFORE any DB read so a dark deploy is a pure no-op 404.
  if (!isLeadFormEnabled()) notFound();

  const query = searchParams ? await searchParams : {};
  const token = query.t ?? "";

  const config = await getLeadFormConfig();
  // MEDIUM-7: the token binds form identity + rev; a missing/tampered/REVOKED (rev-mismatched)
  // token means no form was ever legitimately embedded here → 404 (no page to render).
  if (!verifyLeadFormEmbedToken(token, { rev: config.rev })) notFound();

  // Per-render timing nonce (MEDIUM-1: id is a crypto.randomUUID()).
  const { token: nonceToken } = mintFormNonce();

  return <LeadFormBody config={config} token={token} nonceToken={nonceToken} error={query.error ?? null} />;
}
