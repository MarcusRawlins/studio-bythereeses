import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Unit tests for the stateless signed project-reply token (mirrors
// unsubscribe-token). No DB needed. Fail-closed on unset secret; the tag binds
// projectId so a token minted for A can never verify against B; tamper → null.

async function main() {
  // The secret is read INSIDE each function (not at module load), so a single
  // import suffices and toggling the env var flips fail-closed behavior.
  const { mintProjectReplyToken, verifyProjectReplyToken, projectReplyToAddress } = await import(
    "./project-reply-token"
  );

  // --- Fail-closed mint/verify while the secret is UNSET ---
  delete process.env.REPLY_TOKEN_SECRET;
  {
    const projectId = randomUUID();
    assert.equal(mintProjectReplyToken(projectId), null, "unset secret → mint returns null");
    assert.equal(projectReplyToAddress(projectId), null, "unset secret → no reply address (outbound omits reply_to)");
    assert.equal(verifyProjectReplyToken("anything.anything"), null, "unset secret → verify fails closed");
  }

  // --- With the secret set: round-trip, binding, format, tamper ---
  process.env.REPLY_TOKEN_SECRET = "test-reply-token-secret-value";
  process.env.REPLY_INBOX_DOMAIN = "inbox.bythereeses.com";

  const projectA = randomUUID();
  const projectB = randomUUID();

  const tokenA = mintProjectReplyToken(projectA);
  assert.ok(tokenA, "mint returns a token when the secret is set");
  // Format: two 22-char base64url parts separated by ".", 45 chars total.
  assert.match(tokenA!, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/, "token is two 22-char base64url parts");
  assert.equal(tokenA!.length, 45, "token is 45 chars");

  // Round-trip: verify returns the exact (lowercase) projectId.
  const verifiedA = verifyProjectReplyToken(tokenA);
  assert.deepEqual(verifiedA, { projectId: projectA }, "mint → verify round-trips the projectId");

  // The reply address is <= 64-char local part and shaped as expected.
  const address = projectReplyToAddress(projectA);
  assert.ok(address, "reply address is produced");
  assert.match(address!, /^reply\+[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}@inbox\.bythereeses\.com$/, "address shape");
  const localPart = address!.split("@")[0];
  assert.ok(localPart.length <= 64, "RFC 5321 local-part limit respected");

  // Binding: project A's token can NEVER verify as project B. Its tag binds A.
  assert.notEqual(verifyProjectReplyToken(tokenA)!.projectId, projectB, "A's token is not B");
  const tokenB = mintProjectReplyToken(projectB)!;
  assert.equal(verifyProjectReplyToken(tokenB)!.projectId, projectB, "B's token verifies as B");
  // Transplant A's idPart onto B's tag (and vice versa) → must fail (tag binds id).
  const [idA, tagA] = tokenA!.split(".");
  const [idB, tagB] = tokenB.split(".");
  assert.equal(verifyProjectReplyToken(`${idA}.${tagB}`), null, "A's id with B's tag → null");
  assert.equal(verifyProjectReplyToken(`${idB}.${tagA}`), null, "B's id with A's tag → null");

  // Tamper: flip a byte in the tag → null.
  const flipped = tagA[0] === "A" ? "B" + tagA.slice(1) : "A" + tagA.slice(1);
  assert.equal(verifyProjectReplyToken(`${idA}.${flipped}`), null, "tampered tag → null");

  // Malformed inputs → null (fail-closed, never throws).
  assert.equal(verifyProjectReplyToken(""), null, "empty → null");
  assert.equal(verifyProjectReplyToken(null), null, "null → null");
  assert.equal(verifyProjectReplyToken("only-one-part"), null, "missing '.' → null");
  assert.equal(verifyProjectReplyToken(`${idA}.short`), null, "wrong tag length → null");
  assert.equal(verifyProjectReplyToken(`${idA}.${tagA}.extra`), null, "three parts → null");

  console.log("project reply token tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
