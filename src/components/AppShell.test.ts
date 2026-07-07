import assert from "node:assert/strict";
import { getStudioNavItems } from "./AppShell";

function main() {
  // Flag off: identical to today — same 8 items, in the same order, Settings last.
  const flagOff = getStudioNavItems(false);
  assert.deepEqual(
    flagOff.map((item) => item.href),
    [
      "/proposals",
      "/invoices",
      "/activity",
      "/data-health",
      "/system-status",
      "/questionnaires",
      "/templates",
      "/settings",
    ],
  );

  // Flag on: the three system/ops pages are removed from the top level, and Settings moves up
  // next to Invoices instead of being last.
  const flagOn = getStudioNavItems(true);
  assert.deepEqual(
    flagOn.map((item) => item.href),
    ["/proposals", "/invoices", "/settings", "/questionnaires", "/templates"],
  );
  assert.ok(!flagOn.some((item) => item.href === "/activity"));
  assert.ok(!flagOn.some((item) => item.href === "/data-health"));
  assert.ok(!flagOn.some((item) => item.href === "/system-status"));
  assert.notEqual(flagOn[flagOn.length - 1].href, "/settings");

  console.log("app shell nav tests passed");
}

main();
