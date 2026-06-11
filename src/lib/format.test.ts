import assert from "node:assert/strict";

async function main() {
  const { formatActivityAction } = await import("./format");

  assert.equal(formatActivityAction("proposal.accepted"), "Proposal accepted by client");
  assert.equal(formatActivityAction("proposal.signed"), "Proposal signed by client");
  assert.equal(formatActivityAction("proposal.viewed"), "Client opened the proposal");
  assert.equal(formatActivityAction("project.details_updated"), "Project details updated");
  assert.equal(formatActivityAction("project.location_created"), "Project location added");
  assert.equal(formatActivityAction("project.location_updated"), "Project location updated");
  assert.equal(formatActivityAction("project.location_created_by_agent"), "Project location added by agent");
  assert.equal(formatActivityAction("project.location_updated_by_agent"), "Project location updated by agent");
  assert.equal(formatActivityAction("scheduler_booking.created"), "Call booked");
  assert.equal(formatActivityAction("engagement.scheduled"), "Engagement session scheduled");
  assert.equal(formatActivityAction("invoice.payment_updated"), "Invoice payment updated");
  assert.equal(formatActivityAction("invoice.reminder_logged"), "Invoice reminder logged");
  assert.equal(formatActivityAction("invoice.reminder_logged_by_agent"), "Invoice reminder logged by agent");
  assert.equal(formatActivityAction("project.calendar_synced"), "Project synced to calendar");
  assert.equal(formatActivityAction("project_event.calendar_sync_failed"), "Project event calendar sync failed");
  assert.equal(formatActivityAction("project_source.created"), "Project source created");
  assert.equal(formatActivityAction("custom.agent_event"), "Custom agent event");

  console.log("format tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
