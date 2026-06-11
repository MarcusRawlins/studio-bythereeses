import { db } from "@/db/client";
import { templates } from "@/db/schema";

export type SixFigureWorkflowTemplate = {
  id: string;
  type: "email" | "questionnaire" | "workflow";
  name: string;
  trigger: string;
  subject: string | null;
  body: string;
  status: "active" | "draft" | "archived";
};

export const sixFigureWorkflowTemplates: SixFigureWorkflowTemplate[] = [
  {
    id: "six-figure-workflow-lead-contact-cadence",
    type: "workflow",
    name: "Studio: Lead contact cadence",
    trigger: "New inquiry received",
    subject: "Lead follow-up sequence",
    body: [
      "The Reeses Studio workflow for lead contact cadence.",
      "",
      "1. Contact the lead quickly and log the inquiry source.",
      "2. Send Day 1 introduction text with the scheduling link.",
      "3. Call on Day 1 if the lead has not booked.",
      "4. Call again on Day 2.",
      "5. Send Email 1 on Day 2 and mark the lead as still open.",
      "6. Boomerang/remind 2 days later.",
      "7. Send Email 2.",
      "8. Boomerang/remind 4 days later.",
      "9. Send Email 3 as the final close-the-loop email.",
      "10. If there is still no response, close or nurture the lead without deleting the canonical client/project record.",
    ].join("\n"),
    status: "active",
  },
  {
    id: "six-figure-workflow-consultation-prep",
    type: "workflow",
    name: "Studio: Pre-consultation prep",
    trigger: "Discovery call booked",
    subject: "Pre-consultation sequence",
    body: [
      "Prepare the couple before the first consult while preserving all source material in Studio.",
      "",
      "1. Text or email pre-consultation confirmation.",
      "2. Send a card, gift, or high-touch touchpoint when appropriate.",
      "3. Send an e-session or value gift when it fits the offer.",
      "4. Send a just-because email that reinforces availability, excitement, and the call time.",
      "5. Send or collect get-to-know-you questionnaire answers before the call.",
      "6. Store answers as a project source so proposal/timeline agents can cite them.",
    ].join("\n"),
    status: "active",
  },
  {
    id: "six-figure-workflow-consultation-to-booking",
    type: "workflow",
    name: "Studio: Consultation to booking",
    trigger: "Discovery call completed",
    subject: "Consultation, proposal, order, and booking sequence",
    body: [
      "Move from consult to booked client without losing canonical project state.",
      "",
      "1. Run the design or discovery phone call.",
      "2. Create proposal, contract, and retainer invoice from the discovery-call source.",
      "3. Record order or selected collection in the canonical proposal/invoice records.",
      "4. Confirm booking after signature and retainer payment.",
      "5. Create the premiere date or next planning milestone.",
      "6. Add referral-program touchpoint.",
      "7. Add anniversary/review follow-up reminders.",
    ].join("\n"),
    status: "active",
  },
  {
    id: "six-figure-workflow-planning-to-anniversary",
    type: "workflow",
    name: "Studio: Planning, delivery, referral, anniversary",
    trigger: "Project booked",
    subject: "Booked-client workflow",
    body: [
      "Booked-client sequence adapted for The Reeses Studio.",
      "",
      "1. Send thank-you card or personal touchpoint after booking.",
      "2. Send timeline questionnaire before the planning call.",
      "3. Create the project timeline from questionnaire and planning-call source material.",
      "4. Send scheduling timeline or planning notes.",
      "5. Send one-month-prior text.",
      "6. Complete wedding day/session coverage.",
      "7. Send day-after card or message.",
      "8. Deliver sneak peek or gallery touchpoint.",
      "9. Send album or print sale offer if applicable.",
      "10. Ask for review/referral at the right emotional moment.",
      "11. Send anniversary touchpoint.",
    ].join("\n"),
    status: "active",
  },
  {
    id: "six-figure-workflow-get-to-know-you-questionnaire",
    type: "questionnaire",
    name: "Studio: Get to know you questionnaire outline",
    trigger: "Before discovery/design call",
    subject: null,
    body: [
      "Questionnaire outline adapted from the course reference. Use as a prompt source for a native Studio questionnaire.",
      "",
      "- Specific kind of coverage they are considering.",
      "- What makes them distinctive as a couple/person.",
      "- Interesting details about them.",
      "- Favorite places, teams, coffee/soda/water preferences, and personality cues.",
      "- What they want to be known for or remembered by.",
      "- Names, pronunciation, and contact preferences.",
    ].join("\n"),
    status: "active",
  },
  {
    id: "six-figure-workflow-review-request-email",
    type: "email",
    name: "Studio: Review request email outline",
    trigger: "After positive delivery or sales experience",
    subject: "Would you be willing to share a quick review?",
    body: [
      "Adapted review-request outline for The Reeses Studio.",
      "",
      "Thank the client personally, name the part of the experience you enjoyed serving, ask for a short review, include the review link, and make it clear that even a few sentences are helpful. Keep the tone warm, specific, and low-pressure.",
    ].join("\n"),
    status: "active",
  },
  {
    id: "six-figure-workflow-personal-message-conversion",
    type: "email",
    name: "Studio: Personal message conversion outline",
    trigger: "Warm lead or social/message inquiry",
    subject: "Personal inquiry reply outline",
    body: [
      "Adapted personal-message conversion outline.",
      "",
      "Acknowledge the personal message, affirm why the inquiry matters, move the conversation to a booked call or next clear step, and ask one lightweight question that makes replying easy. Use this for DMs, referrals, and warm inbound conversations.",
    ].join("\n"),
    status: "active",
  },
];

export async function upsertSixFigureWorkflowTemplates(now = new Date().toISOString()) {
  for (const template of sixFigureWorkflowTemplates) {
    await db.insert(templates).values({
      ...template,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: templates.id,
      set: {
        type: template.type,
        name: template.name,
        trigger: template.trigger,
        subject: template.subject,
        body: template.body,
        status: template.status,
        updatedAt: now,
      },
    });
  }

  return {
    upserted: sixFigureWorkflowTemplates.length,
    ids: sixFigureWorkflowTemplates.map((template) => template.id),
  };
}
