import { publicScheduleBaseUrl } from "@/lib/public-urls";
import { getBookingUrl, getProjectBookingUrl } from "@/lib/scheduler";
import { createHmac, timingSafeEqual } from "node:crypto";

export const weddingTimelineQuestionnaireId = "questionnaire-photography-timeline-vision";
export const weddingTimelineCallSlug = "wedding-photography-vision-and-timeline-call";

export type QuestionnaireLinkContext = {
  questionnaireId: string;
  projectId: string | null;
  clientId: string | null;
  expiresAt: string;
};

function questionnaireLinkSecret() {
  const configured = process.env.SCHEDULER_LINK_SECRET || process.env.AUTH_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SCHEDULER_LINK_SECRET (or AUTH_SECRET) must be set in production.");
  }
  return "local-development-questionnaire-link-secret";
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(payload: string) {
  return createHmac("sha256", questionnaireLinkSecret()).update(payload).digest("base64url");
}

export function createQuestionnaireContext(questionnaireId: string, projectId?: string | null, clientId?: string | null) {
  const payload = base64UrlEncode(JSON.stringify({
    questionnaireId,
    projectId: projectId || null,
    clientId: clientId || null,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 90).toISOString(),
  } satisfies QuestionnaireLinkContext));

  return `${payload}.${signPayload(payload)}`;
}

export function verifyQuestionnaireContext(token: string | null | undefined, questionnaireId: string) {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = signPayload(payload);
  const signatureBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const context = JSON.parse(base64UrlDecode(payload)) as QuestionnaireLinkContext;
    if (context.questionnaireId !== questionnaireId || new Date(context.expiresAt) < new Date()) {
      return null;
    }
    return context;
  } catch {
    return null;
  }
}

export function getQuestionnairePublicUrl(questionnaireId: string, contextToken?: string | null) {
  const base = publicScheduleBaseUrl().replace(/\/$/, "");
  const url = new URL(`/questionnaires/${questionnaireId}/preview`, base);
  if (contextToken) url.searchParams.set("context", contextToken);
  return url.toString();
}

export function getQuestionnaireConfirmationUrl(questionnaireId: string, contextToken?: string | null) {
  const base = publicScheduleBaseUrl().replace(/\/$/, "");
  const url = new URL(`/questionnaires/${questionnaireId}/confirmed`, base);
  if (contextToken) url.searchParams.set("context", contextToken);
  return url.toString();
}

export function getTimelineQuestionnaireCallUrl(projectId?: string | null, clientId?: string | null) {
  if (projectId) {
    return getProjectBookingUrl(weddingTimelineCallSlug, projectId, clientId);
  }
  return getBookingUrl(weddingTimelineCallSlug);
}
