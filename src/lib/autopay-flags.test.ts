// Phase 13 §10.1 tests 1-2 — flags are dark + fail-safe (strict, read in body).
import assert from "node:assert/strict";
import {
  autopayBatchMax,
  autopayChargeMode,
  autopayEnabled,
  autopayMaxAttempts,
  autopayMaxChargeCents,
  autopayPilotAllowlist,
} from "./autopay-flags";

// Test 1 — AUTOPAY_ENABLED: ONLY "1" enables; unset/""/"0"/"true"/"on" → OFF.
for (const value of [undefined, "", "0", "true", "on", " 1", "1 ", "yes"]) {
  assert.equal(autopayEnabled({ AUTOPAY_ENABLED: value as string }), false, `AUTOPAY_ENABLED=${JSON.stringify(value)} → OFF`);
}
assert.equal(autopayEnabled({ AUTOPAY_ENABLED: "1" }), true, "AUTOPAY_ENABLED=1 → ON");

// Test 2 — AUTOPAY_CHARGE_MODE: ONLY "live" → live; unset/typo/"log_only" → log_only (fail-safe).
for (const value of [undefined, "", "log_only", "Live", "LIVE", "typo", "1"]) {
  assert.equal(autopayChargeMode({ AUTOPAY_CHARGE_MODE: value as string }), "log_only", `CHARGE_MODE=${JSON.stringify(value)} → log_only`);
}
assert.equal(autopayChargeMode({ AUTOPAY_CHARGE_MODE: "live" }), "live", "CHARGE_MODE=live → live");

// Numeric flags: defaults + parse.
assert.equal(autopayMaxChargeCents({}), 100000, "cap default $1,000");
assert.equal(autopayMaxChargeCents({ AUTOPAY_MAX_CHARGE_CENTS: "50000" }), 50000);
assert.equal(autopayMaxChargeCents({ AUTOPAY_MAX_CHARGE_CENTS: "-5" }), 100000, "negative → default");
assert.equal(autopayMaxAttempts({}), 3, "attempts default 3");
assert.equal(autopayBatchMax({}), 50, "batch default 50");

// Pilot allowlist: unset/empty → null (all); set → a Set of ids.
assert.equal(autopayPilotAllowlist({}), null);
assert.equal(autopayPilotAllowlist({ AUTOPAY_PILOT_ALLOWLIST: "  " }), null);
const allow = autopayPilotAllowlist({ AUTOPAY_PILOT_ALLOWLIST: "proj-a, proj-b ,proj-c" });
assert.ok(allow && allow.has("proj-a") && allow.has("proj-b") && allow.has("proj-c") && allow.size === 3, "allowlist parsed + trimmed");

console.log("autopay-flags.test.ts: all assertions passed");
