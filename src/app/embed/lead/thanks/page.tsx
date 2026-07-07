import { isLeadFormEnabled } from "@/lib/inbound-inquiry";
import { getLeadFormConfig } from "@/lib/lead-form";
import { verifyLeadFormEmbedToken } from "@/lib/lead-form-links";
import { notFound } from "next/navigation";

// MAJOR-2: force-dynamic + proxy `cache-control: private, no-store` (see _worker.js), same rationale
// as the embed page. This is the PRG confirmation shown inside the iframe after a 303.
export const dynamic = "force-dynamic";

export default async function LeadFormThanksPage({
  searchParams,
}: {
  searchParams?: Promise<{ t?: string }>;
}) {
  // I1: flag OFF ⇒ no surface.
  if (!isLeadFormEnabled()) notFound();

  const query = searchParams ? await searchParams : {};
  const token = query.t ?? "";

  const config = await getLeadFormConfig();
  if (!verifyLeadFormEmbedToken(token, { rev: config.rev })) notFound();

  // MEDIUM-3: confirmationMessage is rendered ONLY as an escaped JSX text node (never
  // dangerouslySetInnerHTML). white-space: pre-wrap keeps author line breaks without injecting HTML.
  return (
    <main style={{ margin: 0, padding: "20px", background: "#f8f6f3", color: "#222", fontFamily: "Arial, sans-serif" }}>
      <div style={{ width: "min(560px, 100%)", margin: "0 auto", padding: "28px", border: "1px solid #d5d0c8", borderRadius: "8px", background: "#fffdfa" }}>
        <p role="status" style={{ whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.6, fontSize: "15px", color: "#3a352e" }}>
          {config.confirmationMessage}
        </p>
      </div>
    </main>
  );
}
