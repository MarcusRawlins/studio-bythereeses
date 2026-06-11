import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: ProjectDetailPage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?),
      ('client-2', 'Jordan', 'Taylor', 'jordan@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, notes, created_at, updated_at)
    VALUES (
      'project-1', 'Alex Wedding', 'wedding', 'planning', 'active', '2026-09-19',
      'Imported from HoneyBook on 2026-05-12. HoneyBook project: Alex Wedding. Lead date: 2025-03-11.',
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('participant-1', 'project-1', 'client-1', 'primary', 1, ?),
      ('participant-2', 'project-1', 'client-2', 'partner', 0, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_amount_cents, created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-PROJECT-FEE', 'partially_paid', 900000, 300000,
      'client_pays', 26130, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, created_at, updated_at
    ) VALUES (
      'payment-1', 'invoice-1', 'Retainer', 300000, '2026-06-01', 'paid',
      '2026-06-02T10:00:00.000Z', 'stripe',
      300000, 8730, 8730, 308730,
      300000, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO vendors (id, name, normalized_name, created_at, updated_at)
    VALUES ('vendor-1', 'Second Shooter Co', 'second shooter co', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO expenses (
      id, vendor_id, project_id, category, description, amount_cents, status, paid_at,
      payment_method, tax_deductible, created_at, updated_at
    ) VALUES (
      'expense-unpaid', 'vendor-1', 'project-1', 'contractor', 'Second shooter balance',
      40000, 'unpaid', '2026-06-10', 'ach', 1, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, source_type, source_id,
      created_at, updated_at
    ) VALUES (
      'source-discovery-1', 'project-1', 'discovery_call', 'Discovery call with Alex and Jordan',
      'Transcript notes for proposal and timeline generation.',
      'Source for proposal and timeline drafting.', 'Studio UI', 'studio_project', 'manual-discovery-1',
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_locations (
      id, project_id, type, name, address, city, state, source_type, source_id, created_at, updated_at
    ) VALUES (
      'location-ceremony-1', 'project-1', 'ceremony', 'Garden Lawn',
      '123 Garden Lane', 'Hudson', 'NY', 'questionnaire_response', 'response-1', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_events (
      id, project_id, type, title, event_date, venue_name, notes,
      source_type, source_id, calendar_sync_status, created_at, updated_at
    ) VALUES (
      'event-wedding-1', 'project-1', 'wedding', 'Wedding day', '2026-09-19',
      'Garden House', 'Ceremony begins at 4:30 PM. Reception flow includes toasts and first dance.',
      'questionnaire_response', 'response-1', 'needs_google_connection', ?, ?
    )
  `).run(now, now);

  const markup = renderToStaticMarkup(await ProjectDetailPage({
    params: Promise.resolve({ id: "project-1" }),
    searchParams: Promise.resolve({}),
  }));

  assert.match(markup, /INV-PROJECT-FEE/);
  assert.match(markup, /\$6,174 balance/);
  assert.match(markup, /Accounts payable/);
  assert.match(markup, /\$400/);
  assert.match(markup, /Primary client/);
  assert.match(markup, /action="\/api\/projects\/project-1\/primary-client"/);
  assert.match(markup, /Jordan Taylor · partner/);
  assert.match(markup, /Discovery call with Alex and Jordan/);
  assert.match(markup, /No working notes yet/);
  assert.doesNotMatch(markup, /Imported from HoneyBook on 2026-05-12/);
  assert.match(markup, /Day-of locations/);
  assert.match(markup, /Garden Lawn/);
  assert.match(markup, /123 Garden Lane/);
  assert.match(markup, /Calendar dates/);
  assert.match(markup, /Dates that belong on the calendar/);
  assert.match(markup, /Ceremony begins at 4:30 PM/);
  assert.match(markup, /Locations &amp; logistics/);
  assert.match(markup, /Questionnaire answers can fill these in automatically/);
  assert.match(markup, /Evidence the Studio can cite/);
  assert.match(markup, /Tasks land in the Inbox/);
  assert.match(markup, /Create proposal task/);
  assert.match(markup, /Create timeline task/);
  assert.match(markup, /Create invoice task/);
  assert.match(markup, /Create expense task/);
  assert.match(markup, /Create follow-up task/);
  assert.match(markup, /name="projectSourceId" value="source-discovery-1"/);
  assert.match(markup, /name="assignedAgent" value="Proposal Agent"/);
  assert.match(markup, /name="assignedAgent" value="Timeline Agent"/);
  assert.match(markup, /name="assignedAgent" value="Billing Agent"/);
  assert.match(markup, /name="assignedAgent" value="Bookkeeping Agent"/);
  assert.match(markup, /name="assignedAgent" value="Communications Agent"/);
  assert.match(markup, /Create proposal from Discovery call with Alex and Jordan/);
  assert.match(markup, /Create timeline from Discovery call with Alex and Jordan/);
  assert.match(markup, /Create invoice from Discovery call with Alex and Jordan/);
  assert.match(markup, /Create expense from Discovery call with Alex and Jordan/);
  assert.match(markup, /Create follow-up from Discovery call with Alex and Jordan/);
  assert.match(markup, /Studio workflow/);
  assert.match(markup, /Configure project workflow/);
  assert.doesNotMatch(markup, /Six Figure/);
  assert.match(renderToStaticMarkup(await ProjectDetailPage({
    params: Promise.resolve({ id: "project-1" }),
    searchParams: Promise.resolve({ saved: "location" }),
  })), /Project location saved/);

  await assert.rejects(
    () => ProjectDetailPage({
      params: Promise.resolve({ id: "seed-project-alex-taylor-wedding" }),
      searchParams: Promise.resolve({}),
    }),
    (error) => {
      assert.match(error instanceof Error ? error.message : String(error), /NEXT_REDIRECT/);
      assert.match((error as { digest?: string }).digest ?? "", /;\/projects\?pageSize=200;/);
      assert.doesNotMatch((error as { digest?: string }).digest ?? "", /seed-data-removed/);
      return true;
    },
  );

  console.log("project detail page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
