import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-proposal-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";

function request(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-2', 'Other Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'discovery_call', 'Route proposal discovery call',
      'Route source body.', 'Route source summary', 'Studio UI', ?, ?
    ), (
      'other-source', 'project-2', 'discovery_call', 'Other route source',
      'Wrong route source body.', 'Wrong route summary', 'Studio UI', ?, ?
    )
  `).run(now, now, now, now);

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects/project-1/proposals", {
    method: "POST",
    body: JSON.stringify({ title: "Alex Wedding Proposal", lineItems: [] }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(unauthorized.status, 401);

  const response = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-1/proposals", {
    method: "POST",
    body: JSON.stringify({
      title: "Alex Wedding Proposal",
      packageName: "Heritage Day",
      validUntil: "2026-06-15",
      scopeSummary: "Generated from discovery call notes.",
      contractTitle: "Photography Agreement",
      contractBody: "A short draft agreement.",
      lineItems: [
        { name: "Wedding photography coverage", quantity: 1, unitPriceCents: 900000 },
        { name: "Engagement session", quantity: 1, unitPriceCents: 150000, isOptional: true },
      ],
      sourceType: "project_source",
      sourceId: "source-1",
    }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.proposal.projectId, "project-1");
  assert.equal(body.proposal.status, "draft");
  assert.equal(body.proposal.totalCents, 900000);
  assert.deepEqual(body.proposal.missingFields, ["invoice"]);

  const proposal = database.prepare(`
    SELECT title, package_name, total_cents, status, contract_status, invoice_status, source_type, source_id
    FROM proposals
    WHERE id = ?
  `).get(body.proposal.proposalId);
  assert.deepEqual(proposal, {
    title: "Alex Wedding Proposal",
    package_name: "Heritage Day",
    total_cents: 900000,
    status: "draft",
    contract_status: "ready",
    invoice_status: "not_created",
    source_type: "project_source",
    source_id: "source-1",
  });

  const lineItems = database.prepare(`
    SELECT name, quantity, unit_price_cents, is_optional, sort_order
    FROM proposal_line_items
    WHERE proposal_id = ?
    ORDER BY sort_order
  `).all(body.proposal.proposalId);
  assert.deepEqual(lineItems, [
    {
      name: "Wedding photography coverage",
      quantity: 1,
      unit_price_cents: 900000,
      is_optional: 0,
      sort_order: 0,
    },
    {
      name: "Engagement session",
      quantity: 1,
      unit_price_cents: 150000,
      is_optional: 1,
      sort_order: 1,
    },
  ]);

  const activity = database.prepare("SELECT action, actor_type, metadata FROM activity_logs").get() as {
    action: string;
    actor_type: string;
    metadata: string;
  };
  assert.equal(activity.action, "proposal.created_by_agent");
  assert.equal(activity.actor_type, "agent");
  assert.deepEqual(JSON.parse(activity.metadata), {
    proposalId: body.proposal.proposalId,
    title: "Alex Wedding Proposal",
    status: "draft",
    totalCents: 900000,
    missingFields: ["invoice"],
    sourceType: "project_source",
    sourceId: "source-1",
  });

  const wrongSource = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-1/proposals", {
    method: "POST",
    body: JSON.stringify({
      title: "Wrong source proposal",
      lineItems: [{ name: "Coverage", quantity: 1, unitPriceCents: 100000 }],
      sourceType: "project_source",
      sourceId: "other-source",
    }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(wrongSource.status, 400);
  const wrongSourceBody = await wrongSource.json();
  assert.equal(wrongSourceBody.error, "Project source not found for this project.");

  const updateResponse = await route.PATCH(request(`https://studio.bythereeses.com/api/agent/projects/project-1/proposals?id=${body.proposal.proposalId}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: "Alex Wedding Proposal Revised",
      packageName: "Heritage Weekend",
      scopeSummary: "Revised from follow-up discovery notes.",
      lineItems: [
        { name: "Wedding photography coverage", quantity: 1, unitPriceCents: 950000 },
        { name: "Rehearsal dinner coverage", quantity: 1, unitPriceCents: 125000 },
      ],
      sourceType: "project_source",
      sourceId: "source-1",
    }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(updateResponse.status, 200);
  const updateBody = await updateResponse.json();
  assert.deepEqual(updateBody.proposal, {
    proposalId: body.proposal.proposalId,
    projectId: "project-1",
    status: "draft",
    totalCents: 1075000,
    missingFields: ["invoice"],
  });

  const updatedRows = database.prepare(`
    SELECT name, unit_price_cents, sort_order
    FROM proposal_line_items
    WHERE proposal_id = ?
    ORDER BY sort_order
  `).all(body.proposal.proposalId);
  assert.deepEqual(updatedRows, [
    { name: "Wedding photography coverage", unit_price_cents: 950000, sort_order: 0 },
    { name: "Rehearsal dinner coverage", unit_price_cents: 125000, sort_order: 1 },
  ]);

  const missingProposalId = await route.PATCH(request("https://studio.bythereeses.com/api/agent/projects/project-1/proposals", {
    method: "PATCH",
    body: JSON.stringify({ title: "Missing id" }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(missingProposalId.status, 400);
  assert.deepEqual(await missingProposalId.json(), { error: "Proposal id is required." });

  console.log("agent proposal route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
