import assert from "node:assert/strict";

async function main() {
  const { sendPortalMagicLinkEmail } = await import("./email");

  // No RESEND_API_KEY → returns false, never throws, no network.
  delete process.env.RESEND_API_KEY;
  const noKey = await sendPortalMagicLinkEmail({
    to: "match@example.com",
    clientFirstName: "Avery",
    links: [{ projectName: "Wedding", url: "https://studio.test/portal/login/verify/tok" }],
    ttlMinutes: 20,
  });
  assert.equal(noKey, false, "returns false when RESEND_API_KEY is unset");

  // With a key, inspect the outgoing Resend payload.
  process.env.RESEND_API_KEY = "test-key";
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 200 });
  }) as never;

  try {
    // Multi-project body: one "View {project}" line per link, single email.
    const ok = await sendPortalMagicLinkEmail({
      to: "match@example.com",
      clientFirstName: "Avery",
      links: [
        { projectName: "Wedding A", url: "https://studio.test/portal/login/verify/tokA" },
        { projectName: "Engagement B", url: "https://studio.test/portal/login/verify/tokB" },
      ],
      ttlMinutes: 15,
    });
    assert.equal(ok, true, "returns true on a 200 from Resend");
    assert.equal(sent.length, 1, "one email per request regardless of project count");
    assert.equal(sent[0].url, "https://api.resend.com/emails");
    assert.equal(sent[0].body.subject, "Your Reese Photography portal sign-in link", "canonical subject");
    const text = String(sent[0].body.text);
    assert.match(text, /Hi Avery,/, "greets by first name");
    assert.match(text, /View Wedding A: https:\/\/studio\.test\/portal\/login\/verify\/tokA/);
    assert.match(text, /View Engagement B: https:\/\/studio\.test\/portal\/login\/verify\/tokB/);
    assert.match(text, /expires in 15 minutes and can be used once/);

    // Single-project + null name falls back to "there".
    sent.length = 0;
    await sendPortalMagicLinkEmail({
      to: "solo@example.com",
      clientFirstName: null,
      links: [{ projectName: "Solo Wedding", url: "https://studio.test/portal/login/verify/tokS" }],
      ttlMinutes: 20,
    });
    const soloText = String(sent[0].body.text);
    assert.match(soloText, /Hi there,/, "falls back to 'there' when no first name");
    assert.match(soloText, /View Solo Wedding:/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.RESEND_API_KEY;
  }

  console.log("portal magic link email tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
