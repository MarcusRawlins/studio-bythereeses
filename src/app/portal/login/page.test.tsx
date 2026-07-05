import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

async function main() {
  const { default: PortalLoginPage } = await import("./page");

  async function render(searchParams: { sent?: string; error?: string }) {
    const element = await PortalLoginPage({ searchParams: Promise.resolve(searchParams) });
    return renderToStaticMarkup(element);
  }

  // Flag OFF → fallback copy, no form.
  delete process.env.PORTAL_MAGIC_LINK_ENABLED;
  const off = await render({});
  assert.match(off, /Open a secure portal link from Tyler/, "flag off shows the legacy copy");
  assert.doesNotMatch(off, /action="\/api\/portal\/request-link"/, "flag off renders no request form");

  // Flag ON → the email form.
  process.env.PORTAL_MAGIC_LINK_ENABLED = "1";
  const on = await render({});
  assert.match(on, /action="\/api\/portal\/request-link"/, "flag on renders the request form");
  assert.match(on, /name="email"/, "the form has an email field");
  assert.match(on, /Email me a sign-in link/, "the form has the submit label");

  // ?sent=1 → uniform confirmation.
  const sent = await render({ sent: "1" });
  assert.match(sent, /we&#x27;ve sent a sign-in link|we've sent a sign-in link/, "sent=1 shows the uniform confirmation");

  // ?error=expired → the expired copy.
  const expired = await render({ error: "expired" });
  assert.match(expired, /expired or was already used/, "error=expired shows the expired copy");

  console.log("portal login page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
