import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docPath = join(root, "docs/studio-agent-access.md");
const mcpPath = join(root, "src/lib/studio-mcp.ts");
const doc = readFileSync(docPath, "utf8");
const mcpSource = readFileSync(mcpPath, "utf8");

const requiredSections = [
  "## Operating Reference",
  "## Source of Truth",
  "## Deploy and Smoke Checklist",
  "## Finance Mutation Approval Guard",
  "## Remaining Live Integration Requirements",
  "## Authentication",
  "## MCP Endpoint",
  "## REST Agent Endpoints",
];

for (const section of requiredSections) {
  assert.ok(doc.includes(section), `Missing required section: ${section}`);
}

const mcpToolNames = [...mcpSource.matchAll(/name: "(studio_[a-z_]+)"/g)].map((match) => match[1]);
const uniqueMcpTools = [...new Set(mcpToolNames)].sort();
assert.ok(uniqueMcpTools.length >= 50, `Expected many MCP tools, found ${uniqueMcpTools.length}`);

const docToolNames = [...doc.matchAll(/`(studio_[a-z_]+)`/g)].map((match) => match[1]);
const uniqueDocTools = new Set(docToolNames);

for (const tool of uniqueMcpTools) {
  assert.ok(uniqueDocTools.has(tool), `docs/studio-agent-access.md missing MCP tool reference: ${tool}`);
}

const blockedFinanceTools = [
  "studio_create_invoice",
  "studio_update_invoice",
  "studio_record_invoice_payment",
  "studio_update_invoice_payment",
  "studio_record_scheduler_booking_payment",
  "studio_update_scheduler_booking_payment",
];

for (const tool of blockedFinanceTools) {
  const bulletPattern = new RegExp(`- \`${tool}\`:[^\\n]*Tyler approval`, "i");
  assert.match(doc, bulletPattern, `Blocked finance tool ${tool} should mention Tyler approval in tools/list section`);
}

assert.match(doc, /requireTylerApprovalForAgentFinance/, "Doc should reference sales.ts finance guard");
assert.match(doc, /ops-stabilization-checklist\.md/, "Doc should link ops stabilization checklist");
assert.match(doc, /deployment-live-testing\.md/, "Doc should link deployment live testing");
assert.match(doc, /Obsidian/, "Doc should reference Obsidian source of truth");

const crossLinks = [
  "docs/ops-stabilization-checklist.md",
  "docs/deployment-live-testing.md",
  "docs/backups.md",
  "docs/studio-agent-access.md",
];

for (const relativePath of crossLinks) {
  readFileSync(join(root, relativePath), "utf8");
}

console.log(`studio agent access docs tests passed (${uniqueMcpTools.length} MCP tools documented)`);