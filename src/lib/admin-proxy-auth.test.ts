import assert from "node:assert/strict";

import { ADMIN_PROOF_HEADER, adminProofEnforced, adminProofMode, verifyAdminProxyProof } from "./admin-proxy-auth";

process.env.ADMIN_PROOF_SECRET = "test-admin-proof-secret";

const SECRET = "test-admin-proof-secret";
const HOST = "studio.bythereeses.com";
const ORIGIN = "https://reese-photography-crm.solitary-flower-c3ab.workers.dev";
const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

async function proofFor(opts: {
  method?: string;
  host?: string;
  path: string;
  ts: number;
  secret?: string;
}): Promise<string> {
  const method = opts.method ?? "GET";
  const host = opts.host ?? HOST;
  const sig = await sign(opts.secret ?? SECRET, `${method}\n${host}\n${opts.path}\n${opts.ts}`);
  return `v1.${opts.ts}.${sig}`;
}

function makeRequest(opts: {
  method?: string;
  path: string;
  forwardedHost?: string;
  proof?: string | null;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.forwardedHost !== undefined) headers["x-forwarded-host"] = opts.forwardedHost;
  else headers["x-forwarded-host"] = HOST;
  if (opts.proof) headers[ADMIN_PROOF_HEADER] = opts.proof;
  return new Request(`${ORIGIN}${opts.path}`, { method: opts.method ?? "GET", headers });
}

async function main() {
const now = 1_800_000_000; // fixed unix seconds for deterministic skew checks

// 1. Round-trip: a correctly-signed proof verifies.
{
  const proof = await proofFor({ path: "/finance", ts: now });
  assert.equal(
    await verifyAdminProxyProof(makeRequest({ path: "/finance", proof }), { now }),
    true,
    "correctly-signed proof must verify",
  );
}

// 2. Wrong method -> fail (signed for GET, verified as POST).
{
  const proof = await proofFor({ method: "GET", path: "/finance", ts: now });
  assert.equal(
    await verifyAdminProxyProof(makeRequest({ method: "POST", path: "/finance", proof }), { now }),
    false,
    "method mismatch must fail",
  );
}

// 3. Wrong host -> fail (signed for HOST, verified with a different x-forwarded-host).
{
  const proof = await proofFor({ host: HOST, path: "/finance", ts: now });
  assert.equal(
    await verifyAdminProxyProof(
      makeRequest({ path: "/finance", forwardedHost: "evil.example.com", proof }),
      { now },
    ),
    false,
    "host mismatch must fail (cross-host replay blocked)",
  );
}

// 4. Wrong path -> fail (signed for /finance, presented on /clients).
{
  const proof = await proofFor({ path: "/finance", ts: now });
  assert.equal(
    await verifyAdminProxyProof(makeRequest({ path: "/clients", proof }), { now }),
    false,
    "path mismatch must fail (cross-route replay blocked)",
  );
}

// 5. Expired timestamp (> skew) -> fail.
{
  const staleTs = now - 400; // beyond the default 300s window
  const proof = await proofFor({ path: "/finance", ts: staleTs });
  assert.equal(
    await verifyAdminProxyProof(makeRequest({ path: "/finance", proof }), { now }),
    false,
    "timestamp older than maxSkew must fail",
  );
}

// 5b. Far-future timestamp (> skew) -> fail (two-sided window).
{
  const futureTs = now + 400;
  const proof = await proofFor({ path: "/finance", ts: futureTs });
  assert.equal(
    await verifyAdminProxyProof(makeRequest({ path: "/finance", proof }), { now }),
    false,
    "timestamp far in the future must fail",
  );
}

// 5c. Within the window -> pass; a custom smaller window can reject the same ts.
{
  const skewedTs = now - 200;
  const proof = await proofFor({ path: "/finance", ts: skewedTs });
  assert.equal(
    await verifyAdminProxyProof(makeRequest({ path: "/finance", proof }), { now }),
    true,
    "timestamp within default skew must pass",
  );
  assert.equal(
    await verifyAdminProxyProof(makeRequest({ path: "/finance", proof }), { now, maxSkewSeconds: 60 }),
    false,
    "a tighter maxSkew must reject an otherwise-in-window ts",
  );
}

// 6. Tampered signature (same length, one byte flipped) -> fail. Exercises the
// constant-time comparison path (length matches, content differs).
{
  const proof = await proofFor({ path: "/finance", ts: now });
  const [, ts, sig] = proof.split(".");
  const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  const tampered = `v1.${ts}.${flipped}`;
  assert.equal(tampered.length, proof.length, "tampered proof keeps the same length (constant-time path)");
  assert.equal(
    await verifyAdminProxyProof(makeRequest({ path: "/finance", proof: tampered }), { now }),
    false,
    "tampered signature must fail",
  );
}

// 7. Missing header -> fail (no throw).
{
  assert.equal(
    await verifyAdminProxyProof(makeRequest({ path: "/finance", proof: null }), { now }),
    false,
    "absent proof header must fail",
  );
}

// 8. Malformed header shapes -> fail (no throw).
for (const bad of ["garbage", "v1.only-two", "v2.1800000000.abc", "v1..abc", "v1.notanumber.abc"]) {
  assert.equal(
    await verifyAdminProxyProof(makeRequest({ path: "/finance", proof: bad }), { now }),
    false,
    `malformed proof "${bad}" must fail without throwing`,
  );
}

// 9. Wrong secret used to sign -> fail.
{
  const proof = await proofFor({ path: "/finance", ts: now, secret: "not-the-secret" });
  assert.equal(
    await verifyAdminProxyProof(makeRequest({ path: "/finance", proof }), { now }),
    false,
    "a proof signed with the wrong secret must fail",
  );
}

// 10. Missing secret -> fail closed, never throw.
{
  const proof = await proofFor({ path: "/finance", ts: now });
  const saved = process.env.ADMIN_PROOF_SECRET;
  delete process.env.ADMIN_PROOF_SECRET;
  const result = await verifyAdminProxyProof(makeRequest({ path: "/finance", proof }), { now });
  process.env.ADMIN_PROOF_SECRET = saved;
  assert.equal(result, false, "with no secret configured, verification fails closed (no crash)");
}

// 11. adminProofEnforced only true for exactly "1".
assert.equal(adminProofEnforced({ ADMIN_PROOF_ENFORCE: "1" }), true, "flag '1' enforces");
assert.equal(adminProofEnforced({ ADMIN_PROOF_ENFORCE: "0" }), false, "flag '0' does not enforce");
assert.equal(adminProofEnforced({ ADMIN_PROOF_ENFORCE: "true" }), false, "flag 'true' does not enforce");
assert.equal(adminProofEnforced({}), false, "unset flag does not enforce (fail-open default)");

// 12. Three-state adminProofMode: "1"->enforce, "log"->log, anything else->off.
assert.equal(adminProofMode({ ADMIN_PROOF_ENFORCE: "1" }), "enforce", "'1' -> enforce");
assert.equal(adminProofMode({ ADMIN_PROOF_ENFORCE: "log" }), "log", "'log' -> log-only");
assert.equal(adminProofMode({ ADMIN_PROOF_ENFORCE: "0" }), "off", "'0' -> off");
assert.equal(adminProofMode({ ADMIN_PROOF_ENFORCE: "true" }), "off", "'true' -> off");
assert.equal(adminProofMode({ ADMIN_PROOF_ENFORCE: "LOG" }), "off", "case-sensitive: 'LOG' -> off");
assert.equal(adminProofMode({}), "off", "unset -> off (zero-overhead default)");
assert.equal(adminProofEnforced({ ADMIN_PROOF_ENFORCE: "log" }), false, "log mode is not enforcement");

console.log("admin proxy auth tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
