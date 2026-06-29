import assert from "node:assert/strict";
import { buildTimelineDraftFromProjectContext } from "./timeline-draft";

const context = {
  project: {
    id: "project-1",
    name: "Tiffany & Tim Wedding",
    eventDate: "2026-07-18",
    venueName: "District Winery",
  },
  questionnaireResponses: [{
    id: "response-1",
    answers: [
      { questionId: "q-bride-ready", title: "At what time will the BRIDE be getting ready?", formattedValue: "930AM-2PM, everything should be done by 2" },
      { questionId: "q-groom-ready", title: "At what time will the GROOM be getting ready?", formattedValue: "12PM-2PM" },
      { questionId: "q-first-look", title: "Are you having a First Look?", formattedValue: "Yes" },
      { questionId: "q-ceremony", title: "What time will the ceremony begin? How long do you plan on the ceremony lasting?", formattedValue: "5:30 PM, ~30 mins then cocktail hour" },
      { questionId: "q-cocktail", title: "What time is cocktail hour scheduled to start? Will cocktail hour be held in a separate room from where the reception is being held?", formattedValue: "~6PM pending the ceremony. Cocktail hour is on the patio" },
      { questionId: "q-reception", title: "What time will the reception begin? Are you planning on doing an entrance?", formattedValue: "7 PM, yes" },
      { questionId: "q-flow", title: "What reception events & traditions are you planning on incorporating? Have you thought about the times for these events or the flow of the reception?", formattedValue: "First dance, parent dance, speeches" },
      { questionId: "q-bride-parents", title: "Bride's parent's names. Please include any step-parents to be included in images.", formattedValue: "Lili" },
      { questionId: "q-bride-siblings", title: "Name of Bride's siblings, spouses and children to be included in images.", formattedValue: "Karina + Aaron, Leslie + Joyce, Emily" },
      { questionId: "q-groom-parents", title: "Groom's parent's names. Please include any step-parents to be included in images.", formattedValue: "Peggy & Rob" },
      { questionId: "q-extra-formals", title: "Other desired family formals not listed above .", formattedValue: "Cousins picture\nFamily friends picture" },
      { questionId: "q-bride-location", title: "Getting ready location for the BRIDE. (Please include the name & exact address)", formattedValue: "Thompson Hotel\n221 Tingey St SE, Washington, DC 20003" },
      { questionId: "q-portrait-location", title: "Are there any other locations for the day that we should be aware of?", formattedValue: "Pictures by the monuments if possible" },
      { questionId: "q-family-sensitive", title: "If there are any special circumstances in your family that we should be aware of", formattedValue: "Bride's dad cannot attend." },
    ],
  }],
  locations: [],
  sources: [{
    id: "source-1",
    title: "Questionnaire: Photography Timeline & Vision Questionnaire",
    body: "Questionnaire body",
    sourceType: "questionnaire_response",
    sourceId: "response-1",
    metadata: { responseId: "response-1" },
  }],
};

const draft = buildTimelineDraftFromProjectContext(context, { sourceId: "source-1" });

assert.equal(draft.projectId, "project-1");
assert.deepEqual(draft.sourceIds, ["source-1"]);
assert.ok(draft.timelineItems.some((item) => item.title === "Ceremony" && item.startAt === "05:30 PM"));
assert.ok(draft.timelineItems.some((item) => item.title === "Reception entrance" && item.startAt === "07:00 PM"));
assert.ok(draft.timelineItems.some((item) => item.title === "First look and couple portraits"));
assert.ok(draft.familyFormals.some((group) => group.groupName === "Bride siblings and household" && group.people.includes("Karina")));
assert.ok(draft.locationSuggestions.some((location) => location.role === "bride_getting_ready"));
assert.ok(draft.openQuestions.some((question) => /family-sensitive/i.test(question)));

console.log("timeline draft tests passed");
