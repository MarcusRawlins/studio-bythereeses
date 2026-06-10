import assert from "node:assert/strict";
import { formatRollbackPlan, resolveRollbackTarget } from "./rollback-deploy.mjs";

const manifest = {
  createdAt: "2026-06-10T12:00:00Z",
  git: { head: "abc123", branch: "stabilization/ops-2026-06", dirty: false },
  worker: {
    current: { versionId: "ver-current" },
    previous: { versionId: "ver-previous" },
  },
};

assert.equal(resolveRollbackTarget(manifest), "ver-previous");
assert.equal(resolveRollbackTarget(manifest, { versionId: "ver-explicit" }), "ver-explicit");
assert.equal(resolveRollbackTarget(null), null);

const plan = formatRollbackPlan(manifest, "ver-previous");
assert.match(plan, /ver-previous/);
assert.match(plan, /smoke:production/);
assert.match(plan, /studio-bythereeses/);

console.log("rollback deploy tests passed");