import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { clients, projectEvents, projectLocations, projectParticipants, projectSources, projects, questionnaireQuestions, questionnaireResponses, questionnaires } from "@/db/schema";
import {
  addQuestionnaireQuestion,
  backfillSubmittedQuestionnaireResponseSources,
  createProjectQuestionnaireResponseDraft,
  createQuestionnaireTemplate,
  getQuestionnaireResponseDetail,
  updateQuestionnaireResponseAnswers,
} from "./questionnaires";

const stamp = Date.now();
const clientId = `test-client-${stamp}`;
const unlinkedClientId = `test-unlinked-client-${stamp}`;
const projectId = `test-project-${stamp}`;

async function main() {
  const now = new Date().toISOString();
  const questionnaireId = await createQuestionnaireTemplate({
    title: `Response Management Test ${stamp}`,
    description: "Editable client answers.",
    status: "active",
  });
  let draftIdForCleanup: string | null = null;

  try {
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "Timeline notes",
      type: "paragraph",
      required: true,
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "Instagram",
      type: "short_text",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "Phone number",
      type: "short_text",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "Preferred communication method",
      type: "short_text",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "How did you hear about us?",
      type: "short_text",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "Wedding date",
      type: "short_text",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "Venue name",
      type: "short_text",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "Venue address",
      type: "short_text",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "Wedding city",
      type: "short_text",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "Wedding state",
      type: "short_text",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "Groom's Instagram",
      type: "short_text",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "Getting ready location for the BRIDE. (Please include the name & exact address)",
      type: "paragraph",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "Getting ready location for the GROOM. (Please include the name & exact address)",
      type: "paragraph",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "CEREMONY Location (Please include the name & exact address)",
      type: "paragraph",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "RECEPTION Location (if same as the Ceremony Location, simply enter \"Same as Ceremony\")",
      type: "paragraph",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "Are there any other locations for the day that we should be aware of?",
      type: "paragraph",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "What time will the ceremony begin? How long do you plan on the ceremony lasting?",
      type: "paragraph",
    });
    await addQuestionnaireQuestion({
      questionnaireId,
      title: "What reception events & traditions are you planning on incorporating? Have you thought about the times for these events or the flow of the reception?",
      type: "paragraph",
    });

    await db.insert(clients).values({
      id: clientId,
      firstName: "Test",
      lastName: "Client",
      preferredName: "Test Client",
      email: `questionnaire-response-${stamp}@example.com`,
      phone: null,
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(clients).values({
      id: unlinkedClientId,
      firstName: "Unlinked",
      lastName: "Client",
      preferredName: "Unlinked Client",
      email: `questionnaire-response-unlinked-${stamp}@example.com`,
      phone: null,
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projects).values({
      id: projectId,
      name: "Questionnaire Response Test Project",
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
    await db.insert(projectParticipants).values({
      id: `test-participant-${stamp}`,
      projectId,
      clientId,
      role: "primary",
      isPrimaryContact: true,
      createdAt: now,
    });

    await assert.rejects(
      () => createProjectQuestionnaireResponseDraft({
        questionnaireId,
        projectId,
        clientId: unlinkedClientId,
      }),
      /Questionnaire client is not linked to this project/,
    );

    const driftResponseCount = await db.$client.prepare(`
      SELECT count(*) AS count
      FROM questionnaire_responses
      WHERE project_id = ? AND client_id = ?
    `).get(projectId, unlinkedClientId) as { count: number };
    assert.equal(driftResponseCount.count, 0, "unlinked clients should not get project questionnaire drafts");

    const draftId = await createProjectQuestionnaireResponseDraft({
      questionnaireId,
      projectId,
      clientId,
    });
    draftIdForCleanup = draftId;
    const secondDraftId = await createProjectQuestionnaireResponseDraft({
      questionnaireId,
      projectId,
      clientId,
    });

    assert.equal(secondDraftId, draftId, "draft creation should reuse an open project/client draft");

    const questions = await db.query.questionnaireQuestions.findMany({
      where: eq(questionnaireQuestions.questionnaireId, questionnaireId),
    });
    const timelineQuestion = questions.find((question) => question.title === "Timeline notes");
    const instagramQuestion = questions.find((question) => question.title === "Instagram");
    const phoneQuestion = questions.find((question) => question.title === "Phone number");
    const communicationQuestion = questions.find((question) => question.title === "Preferred communication method");
    const referralQuestion = questions.find((question) => question.title === "How did you hear about us?");
    const weddingDateQuestion = questions.find((question) => question.title === "Wedding date");
    const venueNameQuestion = questions.find((question) => question.title === "Venue name");
    const venueAddressQuestion = questions.find((question) => question.title === "Venue address");
    const weddingCityQuestion = questions.find((question) => question.title === "Wedding city");
    const weddingStateQuestion = questions.find((question) => question.title === "Wedding state");
    const groomInstagramQuestion = questions.find((question) => question.title === "Groom's Instagram");
    const brideGettingReadyQuestion = questions.find((question) => question.title.startsWith("Getting ready location for the BRIDE"));
    const groomGettingReadyQuestion = questions.find((question) => question.title.startsWith("Getting ready location for the GROOM"));
    const ceremonyLocationQuestion = questions.find((question) => question.title.startsWith("CEREMONY Location"));
    const receptionLocationQuestion = questions.find((question) => question.title.startsWith("RECEPTION Location"));
    const otherLocationsQuestion = questions.find((question) => question.title.startsWith("Are there any other locations"));
    const ceremonyTimeQuestion = questions.find((question) => question.title.startsWith("What time will the ceremony begin"));
    const receptionFlowQuestion = questions.find((question) => question.title.startsWith("What reception events"));
    assert.ok(timelineQuestion);
    assert.ok(instagramQuestion);
    assert.ok(phoneQuestion);
    assert.ok(communicationQuestion);
    assert.ok(referralQuestion);
    assert.ok(weddingDateQuestion);
    assert.ok(venueNameQuestion);
    assert.ok(venueAddressQuestion);
    assert.ok(weddingCityQuestion);
    assert.ok(weddingStateQuestion);
    assert.ok(groomInstagramQuestion);
    assert.ok(brideGettingReadyQuestion);
    assert.ok(groomGettingReadyQuestion);
    assert.ok(ceremonyLocationQuestion);
    assert.ok(receptionLocationQuestion);
    assert.ok(otherLocationsQuestion);
    assert.ok(ceremonyTimeQuestion);
    assert.ok(receptionFlowQuestion);

    await updateQuestionnaireResponseAnswers({
      responseId: draftId,
      answers: {
        [timelineQuestion.id]: "Family formals will happen before the ceremony.",
        [instagramQuestion.id]: "testclient",
        [phoneQuestion.id]: "555-0198",
        [communicationQuestion.id]: "Text first, then email.",
        [referralQuestion.id]: "Planner referral",
        [weddingDateQuestion.id]: "2026-09-19",
        [venueNameQuestion.id]: "The Garden House",
        [venueAddressQuestion.id]: "123 Garden Lane",
        [weddingCityQuestion.id]: "Hudson",
        [weddingStateQuestion.id]: "NY",
        [groomInstagramQuestion.id]: "wrongperson",
        [brideGettingReadyQuestion.id]: "The Bridal Suite\n123 Garden Lane, Hudson, NY",
        [groomGettingReadyQuestion.id]: "Carriage House\n125 Garden Lane, Hudson, NY",
        [ceremonyLocationQuestion.id]: "Garden Lawn\n123 Garden Lane, Hudson, NY",
        [receptionLocationQuestion.id]: "The Conservatory",
        [otherLocationsQuestion.id]: "After party at the hotel bar from 10 PM onward.",
        [ceremonyTimeQuestion.id]: "Ceremony begins at 4:30 PM and should last about 20 minutes.",
        [receptionFlowQuestion.id]: "Introductions, first dance, parent dances, toasts, dinner, cake, and open dancing.",
      },
      submit: true,
    });

    const syncedClient = await db.query.clients.findFirst({
      where: eq(clients.id, clientId),
    });
    assert.equal(syncedClient?.instagramHandle, "@testclient");
    assert.equal(syncedClient?.phone, "555-0198");
    assert.equal(syncedClient?.communicationPreference, "Text first, then email.");
    assert.equal(syncedClient?.referralSource, "Planner referral");
    assert.notEqual(syncedClient?.instagramHandle, "@wrongperson", "role-specific answers should not overwrite a generic linked client");

    const syncedProject = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    assert.equal(syncedProject?.eventDate, "2026-09-19", "questionnaire wedding dates should populate an empty canonical project date");
    assert.equal(syncedProject?.venueName, "The Garden House");
    assert.equal(syncedProject?.venueAddress, "123 Garden Lane");
    assert.equal(syncedProject?.city, "Hudson");
    assert.equal(syncedProject?.state, "NY");
    assert.equal(syncedProject?.calendarSyncStatus, "needs_google_connection");

    const detail = await getQuestionnaireResponseDetail(draftId);
    assert.equal(detail?.response.projectId, projectId);
    assert.equal(detail?.response.clientId, clientId);
    assert.ok(detail?.response.submittedAt);
    assert.equal(
      detail?.answers.find((answer) => answer.questionId === timelineQuestion.id)?.value,
      "Family formals will happen before the ceremony.",
    );

    const source = await db.query.projectSources.findFirst({
      where: eq(projectSources.sourceId, draftId),
    });
    assert.equal(source?.projectId, projectId);
    assert.equal(source?.kind, "questionnaire_response");
    assert.equal(source?.title, `Questionnaire: Response Management Test ${stamp}`);
    assert.equal(source?.sourceType, "questionnaire_response");
    assert.equal(source?.sourceId, draftId);
    assert.match(source?.body ?? "", /Timeline notes/);
    assert.match(source?.body ?? "", /Family formals will happen before the ceremony/);

    const syncedLocations = await db.query.projectLocations.findMany({
      where: eq(projectLocations.projectId, projectId),
    });
    assert.equal(syncedLocations.length, 5);
    assert.ok(syncedLocations.some((location) => location.type === "getting_ready" && location.name === "Bride getting ready: The Bridal Suite" && location.address === "123 Garden Lane, Hudson, NY"));
    assert.ok(syncedLocations.some((location) => location.type === "getting_ready" && location.name === "Groom getting ready: Carriage House" && location.address === "125 Garden Lane, Hudson, NY"));
    assert.ok(syncedLocations.some((location) => location.type === "ceremony" && location.name === "Garden Lawn"));
    assert.ok(syncedLocations.some((location) => location.type === "reception" && location.name === "The Conservatory"));
    assert.ok(syncedLocations.some((location) => location.type === "other" && location.name === "Other locations" && location.notes === "After party at the hotel bar from 10 PM onward."));

    const syncedEvent = await db.query.projectEvents.findFirst({
      where: eq(projectEvents.projectId, projectId),
    });
    assert.equal(syncedEvent?.title, "Wedding day");
    assert.equal(syncedEvent?.eventDate, "2026-09-19");
    assert.equal(syncedEvent?.venueName, "The Garden House");
    assert.equal(syncedEvent?.sourceType, "questionnaire_response");
    assert.equal(syncedEvent?.sourceId, draftId);
    assert.match(syncedEvent?.notes ?? "", /Ceremony begins at 4:30 PM/);
    assert.match(syncedEvent?.notes ?? "", /Introductions, first dance/);

    await updateQuestionnaireResponseAnswers({
      responseId: draftId,
      answers: {
        [timelineQuestion.id]: "Family formals will happen after the first look.",
        [venueNameQuestion.id]: "The Conservatory",
      },
      submit: false,
    });

    const editedProject = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    assert.equal(editedProject?.venueName, "The Conservatory");

    const syncedSources = await db.query.projectSources.findMany({
      where: eq(projectSources.sourceId, draftId),
    });
    assert.equal(syncedSources.length, 1, "editing a submitted questionnaire should update the canonical source, not duplicate it");
    assert.match(syncedSources[0].body, /Family formals will happen after the first look/);
    assert.doesNotMatch(syncedSources[0].body, /before the ceremony/);

    const legacyResponseId = `test-legacy-response-${stamp}`;
    const legacySubmittedAt = new Date(Date.now() - 60_000).toISOString();
    await db.insert(questionnaireResponses).values({
      id: legacyResponseId,
      questionnaireId,
      projectId,
      clientId: null,
      respondentName: "Legacy Client",
      respondentEmail: `legacy-questionnaire-${stamp}@example.com`,
      submittedAt: legacySubmittedAt,
      sourceResponseId: null,
      answersJson: JSON.stringify([
        {
          questionId: "legacy-timeline",
          title: "Timeline notes",
          type: "paragraph",
          required: false,
          value: "Legacy response needs canonical project context.",
        },
      ]),
      createdAt: legacySubmittedAt,
      updatedAt: legacySubmittedAt,
    });

    const firstBackfill = await backfillSubmittedQuestionnaireResponseSources();
    assert.ok(firstBackfill.syncedCount >= 1);

    const legacySource = await db.query.projectSources.findFirst({
      where: eq(projectSources.sourceId, legacyResponseId),
    });
    assert.equal(legacySource?.projectId, projectId);
    assert.equal(legacySource?.kind, "questionnaire_response");
    assert.equal(legacySource?.sourceType, "questionnaire_response");
    assert.equal(legacySource?.sourceId, legacyResponseId);
    assert.match(legacySource?.body ?? "", /Timeline notes/);
    assert.match(legacySource?.body ?? "", /Legacy response needs canonical project context/);

    const secondBackfill = await backfillSubmittedQuestionnaireResponseSources();
    assert.equal(secondBackfill.syncedCount, 0, "backfill should not duplicate already-canonical sources");
    const locationsAfterBackfill = await db.query.projectLocations.findMany({
      where: eq(projectLocations.projectId, projectId),
    });
    assert.equal(locationsAfterBackfill.length, 5, "backfill should not duplicate questionnaire-created locations");
  } finally {
    if (draftIdForCleanup) {
      await db.delete(projectSources).where(eq(projectSources.sourceId, draftIdForCleanup));
    }
    await db.delete(projectSources).where(eq(projectSources.projectId, projectId));
    await db.delete(projectEvents).where(eq(projectEvents.projectId, projectId));
    await db.delete(projectLocations).where(eq(projectLocations.projectId, projectId));
    await db.delete(questionnaireResponses).where(eq(questionnaireResponses.questionnaireId, questionnaireId));
    await db.delete(questionnaireQuestions).where(eq(questionnaireQuestions.questionnaireId, questionnaireId));
    await db.delete(questionnaires).where(eq(questionnaires.id, questionnaireId));
    await db.delete(projectParticipants).where(eq(projectParticipants.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(clients).where(eq(clients.id, unlinkedClientId));
    await db.delete(clients).where(eq(clients.id, clientId));
  }

  console.log("questionnaire response management tests passed");
}

main();
