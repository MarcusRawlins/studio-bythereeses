// Phase 19 — §9 tests 12 (config field visibility) + 14 (config stored-XSS inert) + I1 (flag-off
// pages 404). Renders the pure LeadFormBody to static markup and inspects the HTML. Escaping is
// React's default for JSX text nodes; this proves there is NO dangerouslySetInnerHTML path.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Import-time side effect: @/lib/lead-form pulls in @/db/client, which eagerly opens a sqlite db.
// Point it at a throwaway temp dir so this test never touches the shared dev db.
process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reese-lead-render-")), "local.db");
process.env.SCHEDULER_LINK_SECRET = "test-lead-render-secret";

import { renderToStaticMarkup } from "react-dom/server";
import { defaultLeadFormConfig, normalizeLeadFormConfig } from "@/lib/lead-form";
import { LeadFormBody } from "./LeadFormBody";

// ================= Test 12: config field visibility =================
const html = renderToStaticMarkup(
  <LeadFormBody config={defaultLeadFormConfig} token="tok.sig" nonceToken="nonce.sig" />,
);

// Identity fields always present.
assert.match(html, /name="name"/, "name input present");
assert.match(html, /name="email"/, "email input present");
assert.match(html, /name="message"/, "message textarea present");
// Hidden credentials.
assert.match(html, /name="t"[^>]*value="tok.sig"/, "hidden embed token present");
assert.match(html, /name="formNonce"[^>]*value="nonce.sig"/, "hidden nonce present");
// Honeypot present + off-screen.
assert.match(html, /name="company_website"/, "honeypot field present");
assert.match(html, /tabindex="-1"/i, "honeypot is untabbable");
// referralSource is default-disabled → absent.
assert.doesNotMatch(html, /name="referralSource"/, "default-disabled field is absent from the HTML");
// phone is default-enabled → present.
assert.match(html, /name="phone"/, "default-enabled optional field present");

// A field set enabled:false → its input absent even if it would otherwise render.
const noPhone = normalizeLeadFormConfig({
  fields: { phone: { enabled: false, required: false } },
} as never);
const noPhoneHtml = renderToStaticMarkup(<LeadFormBody config={noPhone} token="t.s" nonceToken="n.s" />);
assert.doesNotMatch(noPhoneHtml, /name="phone"/, "disabled phone field is absent from the HTML");

// ================= Test 14: config stored-XSS inert =================
const xssConfig = normalizeLeadFormConfig({
  introText: '<script>alert(1)</script>"><img src=x onerror=alert(2)>',
  submitButtonText: "Send",
} as never);
const xssHtml = renderToStaticMarkup(<LeadFormBody config={xssConfig} token="t.s" nonceToken="n.s" />);
assert.doesNotMatch(xssHtml, /<script>alert\(1\)<\/script>/, "no live <script> element from introText");
assert.doesNotMatch(xssHtml, /<img src=x onerror=/, "no live <img onerror> from introText");
assert.match(xssHtml, /&lt;script&gt;/, "introText <script> rendered as escaped text");

// The submit button text is rendered as an escaped text node too.
const btnConfig = normalizeLeadFormConfig({ submitButtonText: "<b>Go</b>" } as never);
const btnHtml = renderToStaticMarkup(<LeadFormBody config={btnConfig} token="t.s" nonceToken="n.s" />);
assert.doesNotMatch(btnHtml, /<b>Go<\/b>/, "no live markup from submitButtonText");
assert.match(btnHtml, /&lt;b&gt;Go&lt;\/b&gt;/, "submitButtonText rendered escaped");

// The error banner renders only a generic, PII-free message keyed by the error code.
const errHtml = renderToStaticMarkup(
  <LeadFormBody config={defaultLeadFormConfig} token="t.s" nonceToken="n.s" error="email" />,
);
assert.match(errHtml, /valid email address/, "error=email → generic PII-free message");

// ================= I1: flag OFF ⇒ both pages 404 (notFound before any DB read) =================
async function pageFlagOff() {
  delete process.env.LEAD_FORM_ENABLED;
  const { default: LeadPage } = await import("./page");
  const { default: ThanksPage } = await import("./thanks/page");
  for (const [name, Page] of [["embed", LeadPage], ["thanks", ThanksPage]] as const) {
    let threw = false;
    try {
      await Page({ searchParams: Promise.resolve({ t: "x" }) });
    } catch (error) {
      threw = /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/.test((error as Error).message ?? "");
    }
    assert.ok(threw, `${name} page notFound()s when LEAD_FORM_ENABLED is off (I1)`);
  }
}

pageFlagOff()
  .then(() => console.log("lead-form render (field visibility + stored-XSS inert + flag-off 404) tests passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
