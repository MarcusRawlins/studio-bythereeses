import assert from "node:assert/strict";
import { ORIGIN_SECRET_HEADER } from "@/lib/origin-guard";
import { ADMIN_PROOF_HEADER } from "@/lib/admin-proxy-auth";
import { config, middleware } from "./middleware";

process.env.ORIGIN_PROXY_SECRET = "origin-secret";
process.env.ADMIN_PROOF_SECRET = "test-admin-proof-secret";
// Fail-open by default: the enforcement flag is unset for the first block.
delete process.env.ADMIN_PROOF_ENFORCE;

const WORKER_ORIGIN = "https://reese-photography-crm.solitary-flower-c3ab.workers.dev";
const STUDIO_HOST = "studio.bythereeses.com";
const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function proofFor(method: string, host: string, path: string, ts: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(process.env.ADMIN_PROOF_SECRET ?? ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`${method}\n${host}\n${path}\n${ts}`));
  return `v1.${ts}.${base64UrlEncode(new Uint8Array(sig))}`;
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`${WORKER_ORIGIN}${path}`, init);
}

async function withWarnSpy(run: () => Promise<void>): Promise<string[]> {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return warnings;
}

async function main() {
// ---------------------------------------------------------------------------
// Existing origin-guard behavior (now async).
// ---------------------------------------------------------------------------
assert.equal((await middleware(req("/projects/project-123") as never)).status, 404);
assert.equal((await middleware(req("/api/projects", { method: "POST" }) as never)).status, 404);
assert.equal((await middleware(req("/api/finance/ar-aging.csv") as never)).status, 404);

const allowed = await middleware(
  req("/projects/project-123", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret" } }) as never,
);
assert.equal(allowed.status, 200);

const allowedPublicApi = await middleware(
  req("/api/proposal/token-123/accept", { method: "POST" }) as never,
);
assert.equal(allowedPublicApi.status, 200);

// ---------------------------------------------------------------------------
// M4 fail-open: with ADMIN_PROOF_ENFORCE unset, an admin path with NO proof is
// NOT blocked (zero behavior change). The origin secret is supplied so the
// origin guard passes and we isolate the admin-proof decision.
// ---------------------------------------------------------------------------
const failOpen = await middleware(
  req("/finance", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret" } }) as never,
);
assert.equal(failOpen.status, 200, "admin path must NOT be blocked when ADMIN_PROOF_ENFORCE is unset (fail-open)");

// ---------------------------------------------------------------------------
// M4 enforced: ADMIN_PROOF_ENFORCE=1.
// ---------------------------------------------------------------------------
process.env.ADMIN_PROOF_ENFORCE = "1";

// Admin path, no proof -> 404.
const enforcedNoProof = await middleware(
  req("/finance", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret" } }) as never,
);
assert.equal(enforcedNoProof.status, 404, "admin path with no proof must 404 under enforcement");

// Admin path with a valid proof -> allowed. Host is bound to x-forwarded-host.
const now = Math.floor(Date.now() / 1000);
const validProof = await proofFor("GET", STUDIO_HOST, "/finance", now);
const enforcedWithProof = await middleware(
  req("/finance", {
    headers: {
      [ORIGIN_SECRET_HEADER]: "origin-secret",
      "x-forwarded-host": STUDIO_HOST,
      [ADMIN_PROOF_HEADER]: validProof,
    },
  }) as never,
);
assert.equal(enforcedWithProof.status, 200, "admin path with a valid proof must be allowed under enforcement");

// A stale/tampered proof still 404s under enforcement.
const staleProof = await proofFor("GET", STUDIO_HOST, "/finance", now - 10_000);
const enforcedStaleProof = await middleware(
  req("/finance", {
    headers: {
      [ORIGIN_SECRET_HEADER]: "origin-secret",
      "x-forwarded-host": STUDIO_HOST,
      [ADMIN_PROOF_HEADER]: staleProof,
    },
  }) as never,
);
assert.equal(enforcedStaleProof.status, 404, "admin path with an expired proof must 404 under enforcement");

// /portal is NEVER blocked, even under enforcement and with no proof.
const portalEnforced = await middleware(
  req("/portal", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret" } }) as never,
);
assert.equal(portalEnforced.status, 200, "/portal must never be blocked, even under enforcement");

// A public token surface (proposal) is likewise never proof-gated.
const proposalEnforced = await middleware(
  req("/api/proposal/token-123/accept", { method: "POST" }) as never,
);
assert.equal(proposalEnforced.status, 200, "public proposal API must not be proof-gated under enforcement");

// ---------------------------------------------------------------------------
// M4 log-only observation window: ADMIN_PROOF_ENFORCE="log". Evaluates the proof
// for admin surfaces and warns on failure, but NEVER blocks.
// ---------------------------------------------------------------------------
process.env.ADMIN_PROOF_ENFORCE = "log";

// Admin path, no proof -> 200 (not blocked) AND exactly one structured warn.
const logNoProofWarnings = await withWarnSpy(async () => {
  const res = await middleware(
    req("/finance", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret" } }) as never,
  );
  assert.equal(res.status, 200, "log mode must NOT block an admin path missing a proof");
});
assert.equal(logNoProofWarnings.length, 1, "log mode emits exactly one warn for a missing proof");
assert.match(
  logNoProofWarnings[0],
  /^\[admin-proof\] missing\/invalid proof for GET \/finance$/,
  "log warn line is structured and identifies the method + path",
);

// Admin path WITH a valid proof -> 200 and NO warn.
const logValidProof = await proofFor("GET", STUDIO_HOST, "/finance", Math.floor(Date.now() / 1000));
const logValidWarnings = await withWarnSpy(async () => {
  const res = await middleware(
    req("/finance", {
      headers: {
        [ORIGIN_SECRET_HEADER]: "origin-secret",
        "x-forwarded-host": STUDIO_HOST,
        [ADMIN_PROOF_HEADER]: logValidProof,
      },
    }) as never,
  );
  assert.equal(res.status, 200, "log mode allows a valid proof");
});
assert.equal(logValidWarnings.length, 0, "log mode does not warn when the proof is valid");

// /portal never warns or blocks in log mode.
const logPortalWarnings = await withWarnSpy(async () => {
  const res = await middleware(
    req("/portal", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret" } }) as never,
  );
  assert.equal(res.status, 200, "/portal is never blocked in log mode");
});
assert.equal(logPortalWarnings.length, 0, "/portal never warns in log mode");

delete process.env.ADMIN_PROOF_ENFORCE;

// ---------------------------------------------------------------------------
// M4 off (default): with the flag unset the proof is never evaluated — even an
// admin path carrying a bogus proof is neither blocked nor warned (zero work).
// ---------------------------------------------------------------------------
const offWarnings = await withWarnSpy(async () => {
  const res = await middleware(
    req("/finance", {
      headers: { [ORIGIN_SECRET_HEADER]: "origin-secret", [ADMIN_PROOF_HEADER]: "v1.123.bogus" },
    }) as never,
  );
  assert.equal(res.status, 200, "off mode never blocks an admin path");
});
assert.equal(offWarnings.length, 0, "off mode never warns (proof not evaluated at all)");

assert.deepEqual(config.matcher, [
  "/api/:path*",
  "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|.*\\..*).*)",
]);

console.log("middleware origin guard + admin proof tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
