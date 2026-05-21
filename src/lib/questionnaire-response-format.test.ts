import assert from "node:assert/strict";
import { formatQuestionnaireAnswerValue, questionnaireResponseStatus } from "./questionnaires";

assert.equal(questionnaireResponseStatus({ submittedAt: "2026-05-14T12:00:00.000Z" }), "submitted");
assert.equal(questionnaireResponseStatus({ submittedAt: null }), "draft");
assert.equal(formatQuestionnaireAnswerValue("  timeline notes  "), "timeline notes");
assert.equal(formatQuestionnaireAnswerValue(["Ceremony", "Reception"]), "Ceremony\nReception");
assert.equal(formatQuestionnaireAnswerValue([]), "No answer");
assert.equal(formatQuestionnaireAnswerValue(null), "No answer");

console.log("questionnaire response formatting tests passed");
