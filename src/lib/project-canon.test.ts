import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-canon-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { addProjectEventFromForm, addProjectLocationFromForm, createProjectFromForm, linkClientToProjectFromForm, listProjects, updateProjectDetailsFromForm, updateProjectEventFromForm, updateProjectFromForm, updateProjectLocationFromForm } = await import("./crm");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (
      id, name, type, stage, status, event_date, venue_name, venue_address, city, state, budget_cents,
      calendar_sync_status, created_at, updated_at
    ) VALUES (
      'project-1', 'Alex Wedding', 'wedding', 'planning', 'active', '2026-09-19',
      'Old Venue', '1 Old Street', 'Hudson', 'NY', 900000,
      'needs_google_connection', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, email, created_at, updated_at)
    VALUES ('client-2', 'Jordan', 'jordan@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, email, created_at, updated_at)
    VALUES ('client-3', 'Morgan', 'morgan@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-2', 'project-1', 'client-2', 'partner', 0, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_events (
      id, project_id, type, title, event_date, venue_name, venue_address, city, state,
      calendar_sync_status, created_at, updated_at
    ) VALUES (
      'event-1', 'project-1', 'wedding', 'Wedding day', '2026-09-19',
      'Old Venue', '1 Old Street', 'Hudson', 'NY',
      'needs_google_connection', ?, ?
    )
  `).run(now, now);

  const detailsForm = new FormData();
  detailsForm.set("projectId", "project-1");
  detailsForm.set("type", "wedding");
  detailsForm.set("eventDate", "2026-10-03");
  detailsForm.set("venueName", "New Garden House");
  detailsForm.set("venueAddress", "22 New Lane");
  detailsForm.set("city", "Rhinebeck");
  detailsForm.set("state", "NY");
  detailsForm.set("notes", "Updated from project detail page.");

  await updateProjectDetailsFromForm(detailsForm);

  assert.deepEqual(database.prepare(`
    SELECT event_date, venue_name, venue_address, city, state, calendar_sync_status
    FROM project_events
    WHERE id = 'event-1'
  `).get(), {
    event_date: "2026-10-03",
    venue_name: "New Garden House",
    venue_address: "22 New Lane",
    city: "Rhinebeck",
    state: "NY",
    calendar_sync_status: "needs_google_connection",
  });

  const fullForm = new FormData();
  fullForm.set("projectId", "project-1");
  fullForm.set("name", "Alex and Jordan Wedding");
  fullForm.set("type", "wedding");
  fullForm.set("stage", "retainer_paid");
  fullForm.set("status", "active");
  fullForm.set("eventDate", "2026-10-10");
  fullForm.set("venueName", "Final Venue");
  fullForm.set("venueAddress", "99 Final Ave");
  fullForm.set("city", "Kingston");
  fullForm.set("state", "NY");
  fullForm.set("budgetCents", "9500");
  fullForm.set("notes", "Updated from full edit page.");

  await updateProjectFromForm(fullForm);

  assert.deepEqual(database.prepare(`
    SELECT name, event_date, venue_name, venue_address, city, state, budget_cents
    FROM projects
    WHERE id = 'project-1'
  `).get(), {
    name: "Alex and Jordan Wedding",
    event_date: "2026-10-10",
    venue_name: "Final Venue",
    venue_address: "99 Final Ave",
    city: "Kingston",
    state: "NY",
    budget_cents: 950000,
  });

  assert.deepEqual(database.prepare(`
    SELECT event_date, venue_name, venue_address, city, state, calendar_sync_status
    FROM project_events
    WHERE id = 'event-1'
  `).get(), {
    event_date: "2026-10-10",
    venue_name: "Final Venue",
    venue_address: "99 Final Ave",
    city: "Kingston",
    state: "NY",
    calendar_sync_status: "needs_google_connection",
  });

  const eventForm = new FormData();
  eventForm.set("projectId", "project-1");
  eventForm.set("eventId", "event-1");
  eventForm.set("title", "Wedding day");
  eventForm.set("type", "wedding");
  eventForm.set("eventDate", "2026-10-17");
  eventForm.set("venueName", "Event Editor Venue");
  eventForm.set("venueAddress", "14 Event Lane");
  eventForm.set("city", "Saugerties");
  eventForm.set("state", "NY");

  await updateProjectEventFromForm(eventForm);

  assert.deepEqual(database.prepare(`
    SELECT event_date, venue_name, venue_address, city, state
    FROM projects
    WHERE id = 'project-1'
  `).get(), {
    event_date: "2026-10-17",
    venue_name: "Event Editor Venue",
    venue_address: "14 Event Lane",
    city: "Saugerties",
    state: "NY",
  });

  const activity = database.prepare("SELECT action FROM activity_logs ORDER BY created_at").all();
  assert.deepEqual(activity, [
    { action: "project.details_updated" },
    { action: "project.updated" },
    { action: "project.event_updated" },
  ]);

  const listedProjects = await listProjects();
  assert.equal(listedProjects.length, 1);
  assert.equal(listedProjects[0].project.id, "project-1");
  assert.equal(listedProjects[0].client.id, "client-1");

  const createForm = new FormData();
  createForm.set("projectName", "Invalid Stage Wedding");
  createForm.set("firstName", "Casey");
  createForm.set("email", "casey@example.com");
  createForm.set("instagramHandle", "casey.photo");
  createForm.set("communicationPreference", "Text for logistics, email for contracts.");
  createForm.set("referralSource", "Planner referral");
  createForm.set("stage", "not_a_real_stage");
  createForm.set("type", "wedding");
  createForm.append("additionalClientFirstName", "Casey");
  createForm.append("additionalClientLastName", "");
  createForm.append("additionalClientPreferredName", "");
  createForm.append("additionalClientEmail", "CASEY@example.com");
  createForm.append("additionalClientPhone", "");
  createForm.append("additionalClientRole", "partner");
  createForm.append("additionalClientCustomRole", "");

  const createdProjectId = await createProjectFromForm(createForm);
  assert.deepEqual(database.prepare(`
    SELECT stage
    FROM projects
    WHERE id = ?
  `).get(createdProjectId), {
    stage: "inquiry",
  });
  assert.deepEqual(database.prepare(`
    SELECT count(*) AS count
    FROM project_participants
    WHERE project_id = ?
  `).get(createdProjectId), {
    count: 1,
  });
  assert.deepEqual(database.prepare(`
    SELECT instagram_handle, communication_preference, referral_source
    FROM clients
    WHERE email = 'casey@example.com'
  `).get(), {
    instagram_handle: "@casey.photo",
    communication_preference: "Text for logistics, email for contracts.",
    referral_source: "Planner referral",
  });

  const reservedAdditionalRoleForm = new FormData();
  reservedAdditionalRoleForm.set("projectName", "Reserved Role Wedding");
  reservedAdditionalRoleForm.set("firstName", "Taylor");
  reservedAdditionalRoleForm.set("email", "taylor@example.com");
  reservedAdditionalRoleForm.set("type", "wedding");
  reservedAdditionalRoleForm.append("additionalClientFirstName", "Avery");
  reservedAdditionalRoleForm.append("additionalClientLastName", "");
  reservedAdditionalRoleForm.append("additionalClientPreferredName", "");
  reservedAdditionalRoleForm.append("additionalClientEmail", "avery@example.com");
  reservedAdditionalRoleForm.append("additionalClientPhone", "");
  reservedAdditionalRoleForm.append("additionalClientRole", "other");
  reservedAdditionalRoleForm.append("additionalClientCustomRole", "primary");
  const reservedAdditionalRoleProjectId = await createProjectFromForm(reservedAdditionalRoleForm);
  assert.deepEqual(database.prepare(`
    SELECT role, is_primary_contact
    FROM project_participants
    WHERE project_id = ? AND is_primary_contact = 0
  `).get(reservedAdditionalRoleProjectId), {
    role: "participant",
    is_primary_contact: 0,
  });

  const canonicalEventCreateForm = new FormData();
  canonicalEventCreateForm.set("projectId", createdProjectId);
  canonicalEventCreateForm.set("title", "Wedding day");
  canonicalEventCreateForm.set("type", "wedding");
  canonicalEventCreateForm.set("eventDate", "2026-12-05");
  canonicalEventCreateForm.set("venueName", "Created Event Venue");
  canonicalEventCreateForm.set("venueAddress", "77 Created Ave");
  canonicalEventCreateForm.set("city", "Woodstock");
  canonicalEventCreateForm.set("state", "NY");
  await addProjectEventFromForm(canonicalEventCreateForm);
  assert.deepEqual(database.prepare(`
    SELECT event_date, venue_name, venue_address, city, state, calendar_sync_status
    FROM projects
    WHERE id = ?
  `).get(createdProjectId), {
    event_date: "2026-12-05",
    venue_name: "Created Event Venue",
    venue_address: "77 Created Ave",
    city: "Woodstock",
    state: "NY",
    calendar_sync_status: "needs_google_connection",
  });

  const nonCanonicalProjectForm = new FormData();
  nonCanonicalProjectForm.set("projectName", "Blank Event Test Wedding");
  nonCanonicalProjectForm.set("firstName", "Riley");
  nonCanonicalProjectForm.set("email", "riley@example.com");
  nonCanonicalProjectForm.set("type", "wedding");
  const nonCanonicalProjectId = await createProjectFromForm(nonCanonicalProjectForm);

  const nonCanonicalEventCreateForm = new FormData();
  nonCanonicalEventCreateForm.set("projectId", nonCanonicalProjectId);
  nonCanonicalEventCreateForm.set("title", "Rehearsal dinner");
  nonCanonicalEventCreateForm.set("type", "rehearsal");
  nonCanonicalEventCreateForm.set("eventDate", "2026-12-04");
  nonCanonicalEventCreateForm.set("venueName", "Rehearsal Venue");
  await addProjectEventFromForm(nonCanonicalEventCreateForm);
  assert.deepEqual(database.prepare(`
    SELECT event_date, venue_name, calendar_sync_status
    FROM projects
    WHERE id = ?
  `).get(nonCanonicalProjectId), {
    event_date: null,
    venue_name: null,
    calendar_sync_status: "not_connected",
  });

  const addLocationForm = new FormData();
  addLocationForm.set("projectId", createdProjectId);
  addLocationForm.set("type", "getting_ready");
  addLocationForm.set("name", "  The Beekman bridal suite  ");
  addLocationForm.set("address", "  123 Pearl Street  ");
  addLocationForm.set("city", "  New York  ");
  addLocationForm.set("state", "  NY  ");
  addLocationForm.set("notes", "  Load-in through side entrance.  ");
  const locationResult = await addProjectLocationFromForm(addLocationForm);
  assert.equal(locationResult.projectId, createdProjectId);
  assert.ok(locationResult.locationId);
  assert.deepEqual(database.prepare(`
    SELECT project_id, type, name, address, city, state, notes
    FROM project_locations
    WHERE id = ?
  `).get(locationResult.locationId), {
    project_id: createdProjectId,
    type: "getting_ready",
    name: "The Beekman bridal suite",
    address: "123 Pearl Street",
    city: "New York",
    state: "NY",
    notes: "Load-in through side entrance.",
  });

  const updateLocationForm = new FormData();
  updateLocationForm.set("projectId", createdProjectId);
  updateLocationForm.set("locationId", locationResult.locationId);
  updateLocationForm.set("type", "other");
  updateLocationForm.set("customType", "portrait_location");
  updateLocationForm.set("name", "Brooklyn Bridge Park");
  updateLocationForm.set("address", "1 Water Street");
  updateLocationForm.set("city", "Brooklyn");
  updateLocationForm.set("state", "NY");
  updateLocationForm.set("notes", "Permit may be needed.");
  const updateLocationResult = await updateProjectLocationFromForm(updateLocationForm);
  assert.deepEqual(updateLocationResult, { projectId: createdProjectId, locationId: locationResult.locationId });
  assert.deepEqual(database.prepare(`
    SELECT type, name, address, city, state, notes
    FROM project_locations
    WHERE id = ?
  `).get(locationResult.locationId), {
    type: "portrait_location",
    name: "Brooklyn Bridge Park",
    address: "1 Water Street",
    city: "Brooklyn",
    state: "NY",
    notes: "Permit may be needed.",
  });

  const wrongProjectLocationForm = new FormData();
  wrongProjectLocationForm.set("projectId", "project-1");
  wrongProjectLocationForm.set("locationId", locationResult.locationId);
  wrongProjectLocationForm.set("name", "Wrong project edit");
  await assert.rejects(
    () => updateProjectLocationFromForm(wrongProjectLocationForm),
    /Project location not found/,
  );

  const linkForm = new FormData();
  linkForm.set("projectId", createdProjectId);
  linkForm.set("clientId", "client-2");
  linkForm.set("role", "partner");
  const linkResult = await linkClientToProjectFromForm(linkForm);
  assert.deepEqual(linkResult, {
    clientId: "client-2",
    projectId: createdProjectId,
    linked: true,
    role: "partner",
    updated: false,
  });
  assert.deepEqual(database.prepare(`
    SELECT role, is_primary_contact
    FROM project_participants
    WHERE project_id = ? AND client_id = 'client-2'
  `).get(createdProjectId), {
    role: "partner",
    is_primary_contact: 0,
  });

  const roleUpdateForm = new FormData();
  roleUpdateForm.set("projectId", createdProjectId);
  roleUpdateForm.set("clientId", "client-2");
  roleUpdateForm.set("role", "other");
  roleUpdateForm.set("customRole", "planner");
  const roleUpdateResult = await linkClientToProjectFromForm(roleUpdateForm);
  assert.deepEqual(roleUpdateResult, {
    clientId: "client-2",
    projectId: createdProjectId,
    linked: false,
    role: "planner",
    updated: true,
  });
  assert.deepEqual(database.prepare(`
    SELECT role, is_primary_contact
    FROM project_participants
    WHERE project_id = ? AND client_id = 'client-2'
  `).get(createdProjectId), {
    role: "planner",
    is_primary_contact: 0,
  });

  const reservedRoleUpdateForm = new FormData();
  reservedRoleUpdateForm.set("projectId", createdProjectId);
  reservedRoleUpdateForm.set("clientId", "client-2");
  reservedRoleUpdateForm.set("role", "primary");
  const reservedRoleUpdateResult = await linkClientToProjectFromForm(reservedRoleUpdateForm);
  assert.deepEqual(reservedRoleUpdateResult, {
    clientId: "client-2",
    projectId: createdProjectId,
    linked: false,
    role: "participant",
    updated: true,
  });
  assert.deepEqual(database.prepare(`
    SELECT role, is_primary_contact
    FROM project_participants
    WHERE project_id = ? AND client_id = 'client-2'
  `).get(createdProjectId), {
    role: "participant",
    is_primary_contact: 0,
  });

  const duplicateLinkResult = await linkClientToProjectFromForm(reservedRoleUpdateForm);
  assert.deepEqual(duplicateLinkResult, {
    clientId: "client-2",
    projectId: createdProjectId,
    linked: false,
    role: "participant",
    updated: false,
  });
  assert.deepEqual(database.prepare(`
    SELECT count(*) AS count
    FROM project_participants
    WHERE project_id = ? AND client_id = 'client-2'
  `).get(createdProjectId), {
    count: 1,
  });
  assert.deepEqual(database.prepare(`
    SELECT count(*) AS count
    FROM project_participants
    WHERE project_id = ? AND is_primary_contact = 1
  `).get(createdProjectId), {
    count: 1,
  });
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
      VALUES ('participant-extra-primary', ?, 'client-2', 'primary', 1, ?)
    `).run(createdProjectId, now),
    /UNIQUE constraint failed/,
    "a linked partner cannot become a second primary contact through a direct write",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
      VALUES ('participant-new-primary', ?, 'client-3', 'primary', 1, ?)
    `).run(createdProjectId, now),
    /UNIQUE constraint failed/,
    "an unlinked client cannot be inserted as a second primary contact through a direct write",
  );
  assert.deepEqual(database.prepare(`
    SELECT count(*) AS count
    FROM activity_logs
    WHERE project_id = ? AND client_id = 'client-2' AND action = 'client.linked_to_project'
  `).get(createdProjectId), {
    count: 1,
  });
  assert.deepEqual(database.prepare(`
    SELECT count(*) AS count
    FROM activity_logs
    WHERE project_id = ? AND client_id = 'client-2' AND action = 'client.project_role_updated'
  `).get(createdProjectId), {
    count: 2,
  });

  const missingProjectLinkForm = new FormData();
  missingProjectLinkForm.set("projectId", "missing-project");
  missingProjectLinkForm.set("clientId", "client-2");
  await assert.rejects(
    () => linkClientToProjectFromForm(missingProjectLinkForm),
    /Project not found/,
  );

  const missingProjectEventForm = new FormData();
  missingProjectEventForm.set("projectId", "missing-project");
  missingProjectEventForm.set("title", "Rehearsal dinner");
  await assert.rejects(
    () => addProjectEventFromForm(missingProjectEventForm),
    /Project not found/,
  );

  console.log("project canon tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
