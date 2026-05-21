import { AppShell } from "@/components/AppShell";
import { getQuestionnaire, listQuestionnaireResponsesWithContext, questionnaireResponseStatus } from "@/lib/questionnaires";
import { CalendarDays, ClipboardList, FolderKanban, UserRound } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

function formatTimestamp(value: string | null) {
  if (!value) return "Not submitted";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function displayPerson(response: {
  respondentName: string | null;
  respondentEmail: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  clientPreferredName: string | null;
  clientEmail: string | null;
}) {
  const clientName = [response.clientFirstName, response.clientLastName].filter(Boolean).join(" ");
  return response.respondentName || response.clientPreferredName || clientName || response.respondentEmail || response.clientEmail || "Unknown respondent";
}

function displayClient(response: {
  clientFirstName: string | null;
  clientLastName: string | null;
  clientEmail: string | null;
}) {
  const name = [response.clientFirstName, response.clientLastName].filter(Boolean).join(" ");
  return name || response.clientEmail || "No linked client";
}

export default async function QuestionnaireResponsesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const questionnaire = await getQuestionnaire(id);
  if (!questionnaire) notFound();

  const responses = await listQuestionnaireResponsesWithContext(id);
  const submittedCount = responses.filter((response) => questionnaireResponseStatus(response) === "submitted").length;
  const draftCount = responses.length - submittedCount;

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 lg:flex-row lg:items-end">
          <div>
            <Link href={`/questionnaires/${questionnaire.id}`} className="text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">
              Back to questionnaire
            </Link>
            <h1 className="brand-page-title mt-3 text-4xl">Questionnaire responses</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">{questionnaire.title}</p>
          </div>
          <Link href={`/questionnaires/${questionnaire.id}/send`} className="brand-primary-button inline-flex items-center gap-2 rounded-sm px-4 py-2.5 text-xs">
            Send questionnaire
          </Link>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Total responses</div>
            <div className="mt-2 text-3xl font-semibold">{responses.length}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Submitted</div>
            <div className="mt-2 text-3xl font-semibold">{submittedCount}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Drafts</div>
            <div className="mt-2 text-3xl font-semibold">{draftCount}</div>
          </div>
        </section>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] shadow-sm">
          <div className="border-b border-[var(--line)] p-5">
            <h2 className="text-lg font-semibold">Response list</h2>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">Open a response to review every answer and its project/client link.</p>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {responses.map((response) => {
              const status = questionnaireResponseStatus(response);
              return (
                <Link
                  key={response.id}
                  href={`/questionnaires/${questionnaire.id}/responses/${response.id}`}
                  className="grid gap-4 p-5 transition hover:bg-[#fbf9f5] lg:grid-cols-[1.2fr_1fr_1fr_auto]"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <UserRound className="h-4 w-4 text-[var(--ink-muted)]" />
                      <div className="font-semibold">{displayPerson(response)}</div>
                    </div>
                    <div className="mt-1 text-sm text-[var(--ink-muted)]">{response.respondentEmail || response.clientEmail || "No email captured"}</div>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <FolderKanban className="h-4 w-4 text-[var(--ink-muted)]" />
                      {response.projectName || "No linked project"}
                    </div>
                    <div className="mt-1 text-sm text-[var(--ink-muted)]">{displayClient(response)}</div>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <CalendarDays className="h-4 w-4 text-[var(--ink-muted)]" />
                      {status === "submitted" ? "Submitted" : "Draft saved"}
                    </div>
                    <div className="mt-1 text-sm text-[var(--ink-muted)]">{formatTimestamp(response.submittedAt ?? response.updatedAt)}</div>
                  </div>
                  <span className="h-fit w-fit rounded-full border border-[var(--line)] px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                    {status}
                  </span>
                </Link>
              );
            })}
            {!responses.length && (
              <div className="p-8 text-center">
                <ClipboardList className="mx-auto h-5 w-5 text-[var(--ink-muted)]" />
                <p className="mt-3 text-sm text-[var(--ink-muted)]">No client responses have been saved yet.</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
