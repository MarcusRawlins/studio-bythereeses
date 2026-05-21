import assert from "node:assert/strict";
import {
  createQuestionnaireContext,
  getQuestionnaireConfirmationUrl,
  getQuestionnairePublicUrl,
  getTimelineQuestionnaireCallUrl,
  verifyQuestionnaireContext,
} from "./questionnaire-links";

process.env.SCHEDULER_LINK_SECRET = "test-questionnaire-secret";
process.env.NEXT_PUBLIC_SCHEDULE_URL = "https://schedule.bythereeses.com";

const contextToken = createQuestionnaireContext("questionnaire-photography-timeline-vision", "project-123", "client-456");
const context = verifyQuestionnaireContext(contextToken, "questionnaire-photography-timeline-vision");

assert.equal(context?.questionnaireId, "questionnaire-photography-timeline-vision");
assert.equal(context?.projectId, "project-123");
assert.equal(context?.clientId, "client-456");
assert.equal(verifyQuestionnaireContext(contextToken, "different-questionnaire"), null);

const questionnaireUrl = getQuestionnairePublicUrl("questionnaire-photography-timeline-vision", contextToken);
const parsedQuestionnaireUrl = new URL(questionnaireUrl);
assert.equal(parsedQuestionnaireUrl.origin, "https://schedule.bythereeses.com");
assert.equal(parsedQuestionnaireUrl.pathname, "/questionnaires/questionnaire-photography-timeline-vision/preview");
assert.equal(parsedQuestionnaireUrl.searchParams.get("context"), contextToken);

const timelineUrl = getTimelineQuestionnaireCallUrl("project-123", "client-456");
const parsedTimelineUrl = new URL(timelineUrl);
assert.equal(parsedTimelineUrl.origin, "https://schedule.bythereeses.com");
assert.equal(parsedTimelineUrl.pathname, "/book/wedding-photography-vision-and-timeline-call");
assert.ok(parsedTimelineUrl.searchParams.get("project"));

const confirmationUrl = getQuestionnaireConfirmationUrl("questionnaire-photography-timeline-vision", contextToken);
const parsedConfirmationUrl = new URL(confirmationUrl);
assert.equal(parsedConfirmationUrl.origin, "https://schedule.bythereeses.com");
assert.equal(parsedConfirmationUrl.pathname, "/questionnaires/questionnaire-photography-timeline-vision/confirmed");
assert.equal(parsedConfirmationUrl.searchParams.get("context"), contextToken);

console.log("questionnaire links tests passed");
