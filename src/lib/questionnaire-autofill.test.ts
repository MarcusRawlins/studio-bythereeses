import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-questionnaire-autofill-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
delete process.env.QUESTIONNAIRE_AUTOFILL_REVIEW;

async function main() {
  const { db } = await import("@/db/client");
  const {
    clients,
    projectEvents,
    projectLocations,
    projectParticipants,
    projects,
    questionnaireQuestions,
    questionnaireResponses,
  } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const {
    addQuestionnaireQuestion,
    computeClientProfileChanges,
    computeProjectProfileChanges,
    createProjectQuestionnaireResponseDraft,
    createQuestionnaireTemplate,
    updateQuestionnaireResponseAnswers,
  } = await import("./questionnaires");
  const { applyQuestionnaireAutofillProposal } = await import("./questionnaire-autofill");

  type Proposal = {
    version: 1;
    responseId: string;
    computedAt: string;
    contentHash: string;
    project: Array<{ field: string; current: string | null; proposed: string; questionTitle: string; semanticKey?: string }>;
    projectEvent: Array<{ field: string; current: string | null; proposed: string; questionTitle: string }>;
    client: Array<{ field: string; current: string | null; proposed: string; questionTitle: string }>;
    locations: Array<{
      action: "create" | "update";
      type: string;
      existingId?: string;
      proposed: { name: string; address: string | null; city: string | null; state: string | null; notes: string | null };
      current?: { name: string | null; address: string | null; city: string | null; state: string | null; notes: string | null };
    }>;
  };

  function allAcceptedFields(proposal: Proposal) {
    return [
      ...proposal.project.map((change) => change.field),
      ...proposal.client.map((change) => change.field),
      ...proposal.projectEvent.map((change) => change.field),
      ...proposal.locations.flatMap((change, index) => change.action === "create"
        ? [`locations.create.${index}`]
        : (["name", "address", "city", "state", "notes"] as const)
          .filter((field) => change.proposed[field] !== (change.current?.[field] ?? null))
          .map((field) => `locations.${change.existingId}.${field}`)),
    ];
  }

  const stamp = Date.now();
  const now = new Date().toISOString();
  const admin = { actorType: "admin" as const, actorName: "Tyler" };

  const questionnaireId = await createQuestionnaireTemplate({
    title: `Autofill Review Test ${stamp}`,
    status: "active",
  });
  const questions = [
    { key: "brideName", title: "Bride's full name" },
    { key: "instagram", title: "Bride's Instagram" },
    { key: "phone", title: "Bride's phone number" },
    { key: "email", title: "Bride's email" },
    { key: "weddingDate", title: "Wedding date" },
    { key: "venueName", title: "Venue name" },
    { key: "venueAddress", title: "Venue address" },
    { key: "city", title: "Wedding city" },
    { key: "state", title: "Wedding state" },
    { key: "gettingReady", title: "Getting ready location for the BRIDE. (Please include the name & exact address)" },
    { key: "ceremonyLocation", title: "CEREMONY Location (Please include the name & exact address)" },
    { key: "otherLocations", title: "Are there any other locations for the day that we should be aware of?" },
    { key: "ceremonyTime", title: "What time will the ceremony begin? How long do you plan on the ceremony lasting?" },
  ] as const;
  const questionIds: Record<string, string> = {};
  for (const question of questions) {
    questionIds[question.key] = await addQuestionnaireQuestion({
      questionnaireId,
      title: question.title,
      type: question.key === "gettingReady" || question.key === "ceremonyLocation" || question.key === "otherLocations" || question.key === "ceremonyTime" ? "paragraph" : "short_text",
    });
  }

  const projectId = `test-project-autofill-${stamp}`;
  const clientId = `test-client-autofill-${stamp}`;
  const brideEmail = `bride-autofill-${stamp}@example.com`;
  await db.insert(projects).values({
    id: projectId,
    name: "Autofill Review Test Project",
    type: "wedding",
    stage: "planning",
    status: "active",
    eventDate: null,
    venueName: "Old Venue",
    venueAddress: null,
    city: null,
    state: null,
    budgetCents: null,
    googleCalendarEventId: null,
    calendarSyncStatus: "not_connected",
    notes: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(clients).values({
    id: clientId,
    firstName: "Bride",
    lastName: "One",
    preferredName: null,
    email: brideEmail,
    phone: null,
    notes: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectParticipants).values({
    id: `test-participant-autofill-${stamp}`,
    projectId,
    clientId,
    role: "bride",
    isPrimaryContact: true,
    createdAt: now,
  });

  const draftId = await createProjectQuestionnaireResponseDraft({ questionnaireId, projectId, clientId });

  let currentAnswers: Record<string, string> = {
    [questionIds.brideName]: "Bride One",
    [questionIds.instagram]: "brideone",
    [questionIds.phone]: "555-0100",
    [questionIds.email]: brideEmail,
    [questionIds.weddingDate]: "2026-09-19",
    [questionIds.venueName]: "The Grand Hall",
    [questionIds.venueAddress]: "1 Grand Ave",
    [questionIds.city]: "Hudson",
    [questionIds.state]: "NY",
    [questionIds.gettingReady]: "The Bridal Suite\n123 Prep Lane",
    [questionIds.ceremonyLocation]: "Garden Lawn\n123 Prep Lane",
    [questionIds.otherLocations]: "After party at the hotel bar from 10 PM onward.",
    [questionIds.ceremonyTime]: "Ceremony begins at 4:30 PM and lasts 20 minutes.",
  };

  try {
    // -------------------------------------------------------------------
    // Test 1 — Proposal computed, not applied (flag ON, public shape).
    // -------------------------------------------------------------------
    process.env.QUESTIONNAIRE_AUTOFILL_REVIEW = "1";
    const result1 = await updateQuestionnaireResponseAnswers({ responseId: draftId, answers: currentAnswers, submit: true });
    assert.equal(typeof result1, "object", "flag ON should return an object, not the bare responseId string");
    if (typeof result1 === "string") throw new Error("unreachable");
    assert.equal(result1.responseId, draftId);
    assert.ok(result1.proposal, "a proposal should have been computed");
    const proposal1 = result1.proposal as Proposal;

    const projectAfter1 = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    assert.equal(projectAfter1?.venueName, "Old Venue", "flag ON must not write the project (I2)");
    assert.equal(projectAfter1?.eventDate, null, "flag ON must not write the project (I2)");
    const clientAfter1 = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
    assert.equal(clientAfter1?.phone, null, "flag ON must not write the client (I2)");
    const locationsAfter1 = await db.query.projectLocations.findMany({ where: eq(projectLocations.projectId, projectId) });
    assert.equal(locationsAfter1.length, 0, "flag ON must not write project_locations (I2)");
    const eventsAfter1 = await db.query.projectEvents.findMany({ where: eq(projectEvents.projectId, projectId) });
    assert.equal(eventsAfter1.length, 0, "flag ON must not write project_events (I2)");

    const responseRow1 = await db.query.questionnaireResponses.findFirst({ where: eq(questionnaireResponses.id, draftId) });
    assert.ok(responseRow1?.suggestedChangesJson, "suggested_changes_json must be persisted");
    const persistedSource1 = await db.query.projectSources.findFirst({
      where: (source, { and, eq }) => and(eq(source.projectId, projectId), eq(source.sourceId, draftId)),
    });
    assert.ok(persistedSource1, "the non-canonical project_sources transcript row must still be written (I2)");

    const venueChange1 = proposal1.project.find((change) => change.field === "venueName");
    assert.equal(venueChange1?.current, "Old Venue");
    assert.equal(venueChange1?.proposed, "The Grand Hall");
    const eventDateChange1 = proposal1.project.find((change) => change.field === "eventDate");
    assert.equal(eventDateChange1?.current, null);
    assert.equal(eventDateChange1?.proposed, "2026-09-19");
    const phoneChange1 = proposal1.client.find((change) => change.field === "phone");
    assert.equal(phoneChange1?.current, null);
    assert.equal(phoneChange1?.proposed, "555-0100");
    const instagramChange1 = proposal1.client.find((change) => change.field === "instagramHandle");
    assert.equal(instagramChange1?.proposed, "@brideone");
    assert.equal(proposal1.locations.length, 3, "getting-ready, ceremony, and other locations should all be proposed creates");
    assert.ok(proposal1.locations.every((change) => change.action === "create"));
    assert.equal(proposal1.projectEvent.length, 1);
    assert.equal(proposal1.projectEvent[0]?.field, "notes");
    assert.match(proposal1.projectEvent[0]?.proposed ?? "", /Ceremony begins at 4:30 PM/);

    // -------------------------------------------------------------------
    // Test 2 — Apply writes + logs + idempotent.
    // -------------------------------------------------------------------
    const version1 = { computedAt: proposal1.computedAt, contentHash: proposal1.contentHash };
    const apply2a = await applyQuestionnaireAutofillProposal({
      responseId: draftId,
      acceptedFields: allAcceptedFields(proposal1),
      expectedVersion: version1,
      actor: admin,
    });
    assert.equal(apply2a.rejected, false);
    if (apply2a.rejected) throw new Error("unreachable");
    assert.ok(apply2a.applied.length > 0);
    assert.equal(apply2a.skipped.length, 0, "a fresh apply should not skip anything");

    const projectAfter2 = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    assert.equal(projectAfter2?.venueName, "The Grand Hall");
    assert.equal(projectAfter2?.eventDate, "2026-09-19");
    assert.equal(projectAfter2?.venueAddress, "1 Grand Ave");
    assert.equal(projectAfter2?.city, "Hudson");
    assert.equal(projectAfter2?.state, "NY");
    assert.equal(projectAfter2?.calendarSyncStatus, "needs_google_connection");
    const clientAfter2 = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
    assert.equal(clientAfter2?.phone, "555-0100");
    assert.equal(clientAfter2?.instagramHandle, "@brideone");
    const locationsAfter2 = await db.query.projectLocations.findMany({ where: eq(projectLocations.projectId, projectId) });
    assert.equal(locationsAfter2.length, 3);
    const eventAfter2 = await db.query.projectEvents.findFirst({ where: eq(projectEvents.projectId, projectId) });
    assert.ok(eventAfter2);
    assert.equal(eventAfter2?.title, "Wedding day");
    // D9/M6: the event's venue backfill must inherit the FRESHLY applied project
    // venue (proving apply ordering: project-profile before projectEvent), not
    // the pre-apply "Old Venue".
    assert.equal(eventAfter2?.venueName, "The Grand Hall");

    const adminActivity = await db.$client.prepare(`
      SELECT COUNT(*) AS count FROM activity_logs WHERE project_id = ? AND actor_type = 'admin'
    `).get(projectId) as { count: number };
    assert.ok(adminActivity.count > 0, "applies should log actorType:admin activity");

    // Idempotent re-apply with the SAME (still-valid, unchanged) version token —
    // also covers Test 15 (M9): every field must report already_applied, NOT a
    // spurious "changed" sweep.
    const apply2b = await applyQuestionnaireAutofillProposal({
      responseId: draftId,
      acceptedFields: allAcceptedFields(proposal1),
      expectedVersion: version1,
      actor: admin,
    });
    assert.equal(apply2b.rejected, false);
    if (apply2b.rejected) throw new Error("unreachable");
    assert.equal(apply2b.applied.length, 0, "a double-apply should write nothing new");
    assert.ok(apply2b.alreadyApplied.length > 0, "a double-apply should report already_applied for every field");
    assert.equal(apply2b.skipped.length, 0, "Test 15 (M9): already_applied must be checked BEFORE the stale check");

    // -------------------------------------------------------------------
    // Test 3 — Per-field select (D3).
    // -------------------------------------------------------------------
    currentAnswers = { ...currentAnswers, [questionIds.venueName]: "Newer Hall", [questionIds.venueAddress]: "2 New Ave" };
    const result3 = await updateQuestionnaireResponseAnswers({ responseId: draftId, answers: currentAnswers, submit: true });
    if (typeof result3 === "string") throw new Error("unreachable");
    const proposal3 = result3.proposal as Proposal;
    const venueChange3 = proposal3.project.find((change) => change.field === "venueName");
    assert.equal(venueChange3?.current, "The Grand Hall");
    assert.equal(venueChange3?.proposed, "Newer Hall");
    const addressChange3 = proposal3.project.find((change) => change.field === "venueAddress");
    assert.equal(addressChange3?.proposed, "2 New Ave");

    const apply3 = await applyQuestionnaireAutofillProposal({
      responseId: draftId,
      acceptedFields: ["venueAddress"],
      expectedVersion: { computedAt: proposal3.computedAt, contentHash: proposal3.contentHash },
      actor: admin,
    });
    assert.equal(apply3.rejected, false);
    if (apply3.rejected) throw new Error("unreachable");
    assert.ok(apply3.applied.includes("venueAddress"));
    assert.ok(!apply3.applied.includes("venueName"));
    const projectAfter3 = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    assert.equal(projectAfter3?.venueAddress, "2 New Ave", "the accepted field should be applied");
    assert.equal(projectAfter3?.venueName, "The Grand Hall", "the rejected field should stay untouched");

    // -------------------------------------------------------------------
    // Test 4 — Stale-proposal rule (D5, scalar).
    // -------------------------------------------------------------------
    currentAnswers = { ...currentAnswers, [questionIds.venueName]: "Third Hall", [questionIds.city]: "Portland" };
    const result4 = await updateQuestionnaireResponseAnswers({ responseId: draftId, answers: currentAnswers, submit: true });
    if (typeof result4 === "string") throw new Error("unreachable");
    const proposal4 = result4.proposal as Proposal;
    const venueChange4 = proposal4.project.find((change) => change.field === "venueName");
    assert.equal(venueChange4?.current, "The Grand Hall");
    const version4 = { computedAt: proposal4.computedAt, contentHash: proposal4.contentHash };

    // Admin directly edits the project (bypassing the proposal) BETWEEN compute
    // and apply.
    await db.update(projects).set({ venueName: "Tylers Direct Edit", updatedAt: new Date().toISOString() }).where(eq(projects.id, projectId));

    const apply4 = await applyQuestionnaireAutofillProposal({
      responseId: draftId,
      acceptedFields: ["venueName", "city"],
      expectedVersion: version4,
      actor: admin,
    });
    assert.equal(apply4.rejected, false, "D8 must still pass — no resubmission happened, only a direct edit");
    if (apply4.rejected) throw new Error("unreachable");
    assert.ok(apply4.skipped.some((entry) => entry.field === "venueName" && entry.reason === "changed"));
    assert.ok(apply4.applied.includes("city"), "an unrelated accepted field must still apply");
    const projectAfter4 = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    assert.equal(projectAfter4?.venueName, "Tylers Direct Edit", "the newer admin edit must win (D5)");
    assert.equal(projectAfter4?.city, "Portland");

    // -------------------------------------------------------------------
    // Test 7 — Re-submission convergence (D4).
    // -------------------------------------------------------------------
    currentAnswers = { ...currentAnswers, [questionIds.venueName]: "Version A Hall" };
    const resultA = await updateQuestionnaireResponseAnswers({ responseId: draftId, answers: currentAnswers, submit: true });
    if (typeof resultA === "string") throw new Error("unreachable");
    const proposalA = resultA.proposal as Proposal;
    assert.equal(proposalA.project.find((c) => c.field === "venueName")?.proposed, "Version A Hall");

    currentAnswers = { ...currentAnswers, [questionIds.venueName]: "Version B Hall" };
    const resultB = await updateQuestionnaireResponseAnswers({ responseId: draftId, answers: currentAnswers, submit: true });
    if (typeof resultB === "string") throw new Error("unreachable");
    const proposalB = resultB.proposal as Proposal;
    const venueChangesB = proposalB.project.filter((c) => c.field === "venueName");
    assert.equal(venueChangesB.length, 1, "no accumulation — exactly one venueName diff");
    assert.equal(venueChangesB[0]?.proposed, "Version B Hall");
    assert.ok(!JSON.stringify(proposalB).includes("Version A Hall"), "no residue from the superseded submission");

    const resultB2 = await updateQuestionnaireResponseAnswers({ responseId: draftId, answers: currentAnswers, submit: true });
    if (typeof resultB2 === "string") throw new Error("unreachable");
    const proposalB2 = resultB2.proposal as Proposal;
    assert.equal(proposalB2.contentHash, proposalB.contentHash, "resubmitting identical answers is idempotent (D4)");
    assert.deepEqual(
      { project: proposalB2.project, client: proposalB2.client, projectEvent: proposalB2.projectEvent, locations: proposalB2.locations },
      { project: proposalB.project, client: proposalB.client, projectEvent: proposalB.projectEvent, locations: proposalB.locations },
    );

    // -------------------------------------------------------------------
    // Test 9 — No-secrets guard (I5).
    // -------------------------------------------------------------------
    const responseRow9 = await db.query.questionnaireResponses.findFirst({ where: eq(questionnaireResponses.id, draftId) });
    const raw9 = responseRow9?.suggestedChangesJson ?? "";
    assert.ok(!raw9.toLowerCase().includes("context"), "the proposal must carry no context token");
    assert.ok(!raw9.toLowerCase().includes("hmac"), "the proposal must carry no signing material");

    // -------------------------------------------------------------------
    // Test 10 — Proposal-version mismatch rejected (B1 / I7 / D8).
    // -------------------------------------------------------------------
    const staleVersion = { computedAt: proposalB2.computedAt, contentHash: proposalB2.contentHash };
    const projectBeforeReSubmission = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });

    // A client re-submission lands BETWEEN Tyler's review and his Apply click —
    // D4 recompute overwrites suggested_changes_json in place on the SAME row.
    currentAnswers = { ...currentAnswers, [questionIds.venueName]: "Sneaky Unreviewed Value" };
    const resultReSubmit = await updateQuestionnaireResponseAnswers({ responseId: draftId, answers: currentAnswers, submit: true });
    if (typeof resultReSubmit === "string") throw new Error("unreachable");
    const freshProposal = resultReSubmit.proposal as Proposal;
    assert.notEqual(freshProposal.contentHash, staleVersion.contentHash, "the resubmission must have changed the stored proposal");

    const applyStale = await applyQuestionnaireAutofillProposal({
      responseId: draftId,
      acceptedFields: allAcceptedFields(proposalB2),
      expectedVersion: staleVersion,
      actor: admin,
    });
    assert.equal(applyStale.rejected, true, "B1: a stale version token must reject the WHOLE apply");
    if (!applyStale.rejected) throw new Error("unreachable");
    assert.match(applyStale.error, /changed since you reviewed|re-review/i);
    const projectAfterRejectedApply = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    assert.deepEqual(projectAfterRejectedApply, projectBeforeReSubmission, "a rejected apply must write NOTHING (I7)");

    const applyFresh = await applyQuestionnaireAutofillProposal({
      responseId: draftId,
      acceptedFields: allAcceptedFields(freshProposal),
      expectedVersion: { computedAt: freshProposal.computedAt, contentHash: freshProposal.contentHash },
      actor: admin,
    });
    assert.equal(applyFresh.rejected, false, "the FRESH token must succeed");
    const projectAfterFreshApply = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    assert.equal(projectAfterFreshApply?.venueName, "Sneaky Unreviewed Value");

    // -------------------------------------------------------------------
    // Test 11 — Location apply skip reasons (M1).
    // -------------------------------------------------------------------
    const otherRowBefore = await db.query.projectLocations.findFirst({
      where: (location, { and, eq }) => and(eq(location.projectId, projectId), eq(location.type, "other")),
    });
    const ceremonyRowBefore = await db.query.projectLocations.findFirst({
      where: (location, { and, eq }) => and(eq(location.projectId, projectId), eq(location.type, "ceremony")),
    });
    assert.ok(otherRowBefore && ceremonyRowBefore);

    currentAnswers = {
      ...currentAnswers,
      [questionIds.otherLocations]: "After party at the hotel bar until 1 AM, then breakfast.",
      [questionIds.ceremonyLocation]: "Garden Lawn\n125 New Garden Path",
    };
    const result11 = await updateQuestionnaireResponseAnswers({ responseId: draftId, answers: currentAnswers, submit: true });
    if (typeof result11 === "string") throw new Error("unreachable");
    const proposal11 = result11.proposal as Proposal;
    const otherChange11 = proposal11.locations.find((change) => change.action === "update" && change.existingId === otherRowBefore!.id);
    const ceremonyChange11 = proposal11.locations.find((change) => change.action === "update" && change.existingId === ceremonyRowBefore!.id);
    assert.ok(otherChange11, "the other-locations resubmission should match the existing row (M1)");
    assert.ok(ceremonyChange11, "the ceremony resubmission should match the existing row");

    // Admin hand-edits the "other" location's notes BEFORE Tyler applies.
    await db.update(projectLocations).set({ notes: "Tyler's manual note", updatedAt: new Date().toISOString() }).where(eq(projectLocations.id, otherRowBefore!.id));

    const acceptedLocationFields11 = [
      `locations.${otherRowBefore!.id}.notes`,
      `locations.${ceremonyRowBefore!.id}.address`,
      `locations.${ceremonyRowBefore!.id}.notes`,
    ];
    const apply11 = await applyQuestionnaireAutofillProposal({
      responseId: draftId,
      acceptedFields: acceptedLocationFields11,
      expectedVersion: { computedAt: proposal11.computedAt, contentHash: proposal11.contentHash },
      actor: admin,
    });
    assert.equal(apply11.rejected, false);
    if (apply11.rejected) throw new Error("unreachable");
    assert.ok(apply11.skipped.some((entry) => entry.field === `locations.${otherRowBefore!.id}.notes` && entry.reason === "changed"));
    assert.ok(apply11.applied.includes(`locations.${ceremonyRowBefore!.id}.address`));
    assert.ok(apply11.applied.includes(`locations.${ceremonyRowBefore!.id}.notes`));

    const otherRowAfter11 = await db.query.projectLocations.findFirst({ where: eq(projectLocations.id, otherRowBefore!.id) });
    assert.equal(otherRowAfter11?.notes, "Tyler's manual note", "the hand-edited field must survive (M1)");
    const ceremonyRowAfter11 = await db.query.projectLocations.findFirst({ where: eq(projectLocations.id, ceremonyRowBefore!.id) });
    assert.equal(ceremonyRowAfter11?.address, "125 New Garden Path");

    // (b) an existingId row deleted between compute and apply.
    currentAnswers = { ...currentAnswers, [questionIds.ceremonyLocation]: "Garden Lawn\n999 Deleted Row Lane" };
    const result11b = await updateQuestionnaireResponseAnswers({ responseId: draftId, answers: currentAnswers, submit: true });
    if (typeof result11b === "string") throw new Error("unreachable");
    const proposal11b = result11b.proposal as Proposal;
    const ceremonyChange11b = proposal11b.locations.find((change) => change.existingId === ceremonyRowBefore!.id);
    assert.ok(ceremonyChange11b);

    await db.delete(projectLocations).where(eq(projectLocations.id, ceremonyRowBefore!.id));

    const apply11b = await applyQuestionnaireAutofillProposal({
      responseId: draftId,
      acceptedFields: [`locations.${ceremonyRowBefore!.id}.address`, `locations.${ceremonyRowBefore!.id}.notes`],
      expectedVersion: { computedAt: proposal11b.computedAt, contentHash: proposal11b.contentHash },
      actor: admin,
    });
    assert.equal(apply11b.rejected, false);
    if (apply11b.rejected) throw new Error("unreachable");
    assert.ok(apply11b.skipped.every((entry) => entry.reason === "existing_missing"));
    assert.ok(apply11b.skipped.some((entry) => entry.field === `locations.${ceremonyRowBefore!.id}.address`));
    const ceremonyRowsAfter11b = await db.query.projectLocations.findMany({
      where: (location, { and, eq }) => and(eq(location.projectId, projectId), eq(location.type, "ceremony")),
    });
    assert.equal(ceremonyRowsAfter11b.length, 0, "a deleted row must not be silently re-inserted");

    // -------------------------------------------------------------------
    // Test 13 — Email collision re-run at apply (M2).
    // -------------------------------------------------------------------
    const collidingEmail = `collision-${stamp}@example.com`;
    await db.insert(clients).values({
      id: `test-client-collision-${stamp}`,
      firstName: "Someone",
      lastName: "Else",
      email: collidingEmail,
      createdAt: now,
      updatedAt: now,
    });

    currentAnswers = { ...currentAnswers, [questionIds.email]: collidingEmail, [questionIds.phone]: "555-0199" };
    const result13 = await updateQuestionnaireResponseAnswers({ responseId: draftId, answers: currentAnswers, submit: true });
    if (typeof result13 === "string") throw new Error("unreachable");
    const proposal13 = result13.proposal as Proposal;
    const emailChange13 = proposal13.client.find((change) => change.field === "email");
    const phoneChange13 = proposal13.client.find((change) => change.field === "phone");
    assert.equal(emailChange13?.proposed, collidingEmail);
    assert.equal(phoneChange13?.proposed, "555-0199");

    const apply13 = await applyQuestionnaireAutofillProposal({
      responseId: draftId,
      acceptedFields: ["email", "phone"],
      expectedVersion: { computedAt: proposal13.computedAt, contentHash: proposal13.contentHash },
      actor: admin,
    });
    assert.equal(apply13.rejected, false);
    if (apply13.rejected) throw new Error("unreachable");
    assert.ok(apply13.skipped.some((entry) => entry.field === "email" && entry.reason === "email_collision"));
    assert.ok(apply13.applied.includes("phone"), "an unrelated accepted field must still apply");
    const clientAfter13 = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
    assert.equal(clientAfter13?.email, brideEmail, "the colliding email must never be written");
    assert.equal(clientAfter13?.phone, "555-0199");

    // -------------------------------------------------------------------
    // Test 5 — Flag-OFF unchanged, ALL FOUR syncs (regression pin, I1 + M10).
    // A fresh project/client so this scenario is fully isolated.
    // -------------------------------------------------------------------
    delete process.env.QUESTIONNAIRE_AUTOFILL_REVIEW;

    const projectId2 = `test-project-flagoff-${stamp}`;
    const clientId2 = `test-client-flagoff-${stamp}`;
    await db.insert(projects).values({
      id: projectId2,
      name: "Flag Off Regression Project",
      type: "wedding",
      stage: "planning",
      status: "active",
      eventDate: null,
      venueName: null,
      venueAddress: null,
      city: null,
      state: null,
      budgetCents: null,
      googleCalendarEventId: null,
      calendarSyncStatus: "not_connected",
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(clients).values({
      id: clientId2,
      firstName: "Groom",
      lastName: "Two",
      email: `groom-flagoff-${stamp}@example.com`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectParticipants).values({
      id: `test-participant-flagoff-${stamp}`,
      projectId: projectId2,
      clientId: clientId2,
      role: "bride",
      isPrimaryContact: true,
      createdAt: now,
    });

    const draftId2 = await createProjectQuestionnaireResponseDraft({ questionnaireId, projectId: projectId2, clientId: clientId2 });
    const answers2: Record<string, string> = {
      [questionIds.brideName]: "Bride Two",
      [questionIds.instagram]: "bridetwo",
      [questionIds.phone]: "555-0200",
      [questionIds.email]: `groom-flagoff-${stamp}@example.com`,
      [questionIds.weddingDate]: "2026-10-10",
      [questionIds.venueName]: "Flag Off Venue",
      [questionIds.venueAddress]: "5 Flag Off Ave",
      [questionIds.city]: "Albany",
      [questionIds.state]: "NY",
      [questionIds.gettingReady]: "The Prep Room\n5 Flag Off Ave",
      [questionIds.ceremonyLocation]: "Flag Off Lawn\n5 Flag Off Ave",
      [questionIds.otherLocations]: "No other locations.",
      [questionIds.ceremonyTime]: "Ceremony begins at 2:00 PM and lasts 25 minutes.",
    };
    const result5 = await updateQuestionnaireResponseAnswers({ responseId: draftId2, answers: answers2, submit: true });
    assert.equal(typeof result5, "string", "flag OFF must return the bare responseId string (I1)");
    assert.equal(result5, draftId2);

    const projectAfter5 = await db.query.projects.findFirst({ where: eq(projects.id, projectId2) });
    assert.equal(projectAfter5?.venueName, "Flag Off Venue", "flag OFF: direct write to projects");
    assert.equal(projectAfter5?.eventDate, "2026-10-10");
    const clientAfter5 = await db.query.clients.findFirst({ where: eq(clients.id, clientId2) });
    assert.equal(clientAfter5?.phone, "555-0200", "flag OFF: direct write to clients");
    const locationsAfter5 = await db.query.projectLocations.findMany({ where: eq(projectLocations.projectId, projectId2) });
    assert.ok(locationsAfter5.length >= 2, "flag OFF: direct write to project_locations");
    const eventAfter5 = await db.query.projectEvents.findFirst({ where: eq(projectEvents.projectId, projectId2) });
    assert.ok(eventAfter5, "flag OFF: direct write to project_events");
    const sourceAfter5 = await db.query.projectSources.findFirst({
      where: (source, { and, eq }) => and(eq(source.projectId, projectId2), eq(source.sourceId, draftId2)),
    });
    assert.ok(sourceAfter5, "the project_sources transcript sync still runs in both branches");

    const systemActivityRows = await db.$client.prepare(`
      SELECT DISTINCT action FROM activity_logs WHERE project_id = ? AND actor_type = 'system'
    `).all(projectId2) as Array<{ action: string }>;
    const systemActions = new Set(systemActivityRows.map((row) => row.action));
    assert.ok(systemActions.has("project.profile_synced_from_questionnaire"));
    assert.ok(systemActions.has("client.profile_synced_from_questionnaire"));
    assert.ok(systemActions.has("project.locations_synced_from_questionnaire"));
    assert.ok(systemActions.has("project.event_synced_from_questionnaire"));

    const responseRow5 = await db.query.questionnaireResponses.findFirst({ where: eq(questionnaireResponses.id, draftId2) });
    assert.equal(responseRow5?.suggestedChangesJson, null, "flag OFF must never write a proposal");

    // -------------------------------------------------------------------
    // Test 8 — semantic_key precedence + isolation (§5, M8).
    // Exercised directly against the pure compute halves for precision.
    // -------------------------------------------------------------------
    const semanticQuestionnaireId = await createQuestionnaireTemplate({ title: `Semantic Key Test ${stamp}`, status: "active" });
    const semanticVenueQuestionId = await addQuestionnaireQuestion({
      questionnaireId: semanticQuestionnaireId,
      title: "Preferred spot", // ambiguous — no "venue"/"location" keyword
      type: "short_text",
    });
    await db.update(questionnaireQuestions).set({ semanticKey: "venue_name" }).where(eq(questionnaireQuestions.id, semanticVenueQuestionId));
    const ambiguousLocationQuestionId = await addQuestionnaireQuestion({
      questionnaireId: semanticQuestionnaireId,
      title: "Ceremony location details", // contains the "location" keyword
      type: "short_text",
    });
    await db.update(questionnaireQuestions).set({ semanticKey: "ceremony_location" }).where(eq(questionnaireQuestions.id, ambiguousLocationQuestionId));

    const semanticProjectRow = { id: "semantic-project", venueName: null, venueAddress: null, city: null, state: null, eventDate: null } as unknown as typeof projects.$inferSelect;
    const semanticProjectChanges = computeProjectProfileChanges({
      response: { projectId: "semantic-project" },
      project: semanticProjectRow,
      answers: [
        { title: "Preferred spot", value: "Sunset Gardens", semanticKey: "venue_name" },
        { title: "Ceremony location details", value: "The Old Barn", semanticKey: "ceremony_location" },
      ],
    });
    const semanticVenueChange = semanticProjectChanges.find((change) => change.field === "venueName");
    assert.equal(semanticVenueChange?.proposed, "Sunset Gardens", "a semantic_key match should apply even without a title keyword");
    assert.equal(semanticVenueChange?.semanticKey, "venue_name");
    assert.ok(
      !JSON.stringify(semanticProjectChanges).includes("The Old Barn"),
      "M8 rule 1: a ceremony_location-keyed answer must NOT double-match venueName via the 'location' keyword",
    );

    const keylessProjectChanges = computeProjectProfileChanges({
      response: { projectId: "semantic-project" },
      project: semanticProjectRow,
      answers: [{ title: "Venue name", value: "Keyword Matched Hall" }],
    });
    assert.equal(keylessProjectChanges.find((change) => change.field === "venueName")?.proposed, "Keyword Matched Hall", "a keyless question still matches by keyword");

    const brideClientRow = { id: "bride-role-client", instagramHandle: null, phone: null, communicationPreference: null, referralSource: null, preferredName: null, firstName: "Bride", lastName: null, email: "bride-role@example.com" } as unknown as typeof clients.$inferSelect;
    const groomPhoneChanges = computeClientProfileChanges({
      response: { clientId: "groom-role-client" },
      client: brideClientRow,
      participantRole: "groom",
      answers: [{ title: "Bride's cell", value: "555-9999", semanticKey: "client_phone" }],
    });
    assert.equal(groomPhoneChanges.find((change) => change.field === "phone"), undefined, "a bride-tagged client_phone must not populate the groom's record");
    const bridePhoneChanges = computeClientProfileChanges({
      response: { clientId: "bride-role-client" },
      client: brideClientRow,
      participantRole: "bride",
      answers: [{ title: "Bride's cell", value: "555-9999", semanticKey: "client_phone" }],
    });
    assert.equal(bridePhoneChanges.find((change) => change.field === "phone")?.proposed, "555-9999", "the bride's own role should still receive the keyed value");

    console.log("questionnaire autofill review tests passed");
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
