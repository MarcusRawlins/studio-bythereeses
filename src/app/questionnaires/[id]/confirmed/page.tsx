import {
  getTimelineQuestionnaireCallUrl,
  verifyQuestionnaireContext,
  weddingTimelineQuestionnaireId,
} from "@/lib/questionnaire-links";
import { getQuestionnaire } from "@/lib/questionnaires";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function QuestionnaireConfirmedPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ context?: string }>;
}) {
  const { id } = await params;
  const { context = "" } = await searchParams;
  const questionnaire = await getQuestionnaire(id);
  if (!questionnaire) notFound();

  const verifiedContext = verifyQuestionnaireContext(context, questionnaire.id);
  const scheduleUrl = questionnaire.id === weddingTimelineQuestionnaireId
    ? getTimelineQuestionnaireCallUrl(verifiedContext?.projectId, verifiedContext?.clientId)
    : getTimelineQuestionnaireCallUrl();

  return (
    <main className="min-h-screen bg-[var(--background)] px-4 py-10 text-[var(--foreground)]">
      <div className="mx-auto max-w-2xl text-center">
        <div>
          <span className="studio-caps block text-[0.62rem] text-[var(--ink-muted)]">The Reeses</span>
          <span className="font-serif text-3xl leading-none text-[var(--foreground)]">Studio</span>
        </div>
        <section className="mt-10 rounded-md border border-[var(--line)] bg-[var(--surface)] px-7 py-10 shadow-sm">
          <CheckCircle2 className="mx-auto h-9 w-9 text-[var(--brand-brown)]" />
          <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-muted)]">Questionnaire submitted</p>
          <h1 className="mt-3 font-['Times_Now',Georgia,serif] text-4xl leading-tight">
            Thank you. Your answers are in.
          </h1>
          <p className="mx-auto mt-5 max-w-lg text-sm leading-6 text-[var(--ink-muted)]">
            The next step is to schedule your wedding photography vision and timeline call so we can walk through the details together.
          </p>
          <Link href={scheduleUrl} className="brand-primary-button mt-8 inline-flex items-center gap-2 rounded-sm px-5 py-3">
            Schedule vision call
            <ArrowRight className="h-4 w-4" />
          </Link>
        </section>
      </div>
    </main>
  );
}
