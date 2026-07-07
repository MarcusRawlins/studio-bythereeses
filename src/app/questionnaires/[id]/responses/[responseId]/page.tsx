import { AppShell } from "@/components/AppShell";
import {
  getQuestionnaireResponseDetail,
  questionnaireAutofillReviewEnabled,
  questionnaireResponseStatus,
} from "@/lib/questionnaires";
import { Bot, CalendarDays, FolderKanban, Mail, Pencil, UserRound } from "lucide-react";
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

function displayClient(response: {
  clientFirstName: string | null;
  clientLastName: string | null;
  clientEmail: string | null;
}) {
  const name = [response.clientFirstName, response.clientLastName].filter(Boolean).join(" ");
  return name || response.clientEmail || "No linked client";
}

const FIELD_LABELS: Record<string, string> = {
  eventDate: "Event date",
  venueName: "Venue name",
  venueAddress: "Venue address",
  city: "City",
  state: "State",
  instagramHandle: "Instagram",
  phone: "Phone",
  communicationPreference: "Communication preference",
  referralSource: "Referral source",
  preferredName: "Preferred name",
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  notes: "Wedding day notes",
  name: "Location name",
  address: "Location address",
};

function fieldLabel(field: string) {
  return FIELD_LABELS[field] ?? field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (char) => char.toUpperCase());
}

function FieldChangeRow({
  sectionField,
  current,
  proposed,
  questionTitle,
  stale,
  checkboxName,
}: {
  sectionField: string;
  current: string | null;
  proposed: string;
  questionTitle?: string;
  stale: boolean;
  checkboxName: string;
}) {
  return (
    <label className="flex items-start gap-3 border-b border-[var(--line-soft)] p-4 last:border-b-0">
      <input type="checkbox" name="acceptedFields" value={checkboxName} defaultChecked className="mt-1 h-4 w-4" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{fieldLabel(sectionField)}</span>
          {stale && (
            <span className="rounded-full border border-[var(--brand-brown)] px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.08em] text-[var(--brand-brown)]">
              Changed since computed
            </span>
          )}
        </div>
        <div className="mt-1 grid gap-1 text-sm sm:grid-cols-2">
          <div className="text-[var(--ink-muted)]">
            <span className="text-xs uppercase tracking-[0.08em]">Current</span>
            <div className="whitespace-pre-wrap">{current || "(empty)"}</div>
          </div>
          <div>
            <span className="text-xs uppercase tracking-[0.08em] text-[var(--ink-muted)]">Proposed</span>
            <div className="whitespace-pre-wrap font-semibold">{proposed}</div>
          </div>
        </div>
        {questionTitle && <div className="mt-1 text-xs text-[var(--ink-muted)]">From: {questionTitle}</div>}
      </div>
    </label>
  );
}

export default async function QuestionnaireResponseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; responseId: string }>;
  searchParams?: Promise<{ saved?: string; applyError?: string }>;
}) {
  const { id, responseId } = await params;
  const query = (await searchParams) ?? {};
  const detail = await getQuestionnaireResponseDetail(responseId);
  if (!detail || detail.response.questionnaireId !== id) notFound();

  const { response, answers, proposal } = detail;
  const autofillReviewOn = questionnaireAutofillReviewEnabled();
  const hasSuggestedChanges = Boolean(
    proposal && (proposal.project.length || proposal.client.length || proposal.projectEvent.length || proposal.locations.length),
  );
  const status = questionnaireResponseStatus(response);
  const respondent = response.respondentName || response.respondentEmail || displayClient(response);
  const backHref = response.projectId ? `/projects/${response.projectId}` : `/questionnaires/${id}/responses`;
  const backLabel = response.projectId ? "Back to project" : "Back to responses";
  const responseHref = `/questionnaires/${id}/responses/${responseId}`;
  const timelineTaskInstructions = [
    `Use questionnaire response ${responseId} (${responseHref}) as the planning source.`,
    "Create a wedding day timeline draft and a family formal list draft for Tyler to review.",
    "Use the Studio timeline templates and preserve any uncertainty as review notes instead of inventing facts.",
    "Do not change the canonical wedding date.",
  ].join("\n");

  return (
    <AppShell>
      <div className="space-y-5">
        <header className="border-b border-[var(--line)] pb-4">
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div>
            <Link href={backHref} className="text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">
              {backLabel}
            </Link>
            <h1 className="brand-page-title mt-3 text-4xl">Questionnaire response</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">{response.questionnaireTitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="h-fit w-fit rounded-full border border-[var(--line)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              {status}
            </span>
            {response.projectId && (
              <form action={`/api/projects/${response.projectId}/agent-tasks`} method="post">
                <input type="hidden" name="title" value={`Create timeline and family formal list from ${response.questionnaireTitle}`} />
                <input type="hidden" name="instructions" value={timelineTaskInstructions} />
                <input type="hidden" name="priority" value="normal" />
                <input type="hidden" name="assignedAgent" value="Timeline Agent" />
                <input type="hidden" name="projectSourceId" value={response.projectSourceId ?? ""} />
                <input type="hidden" name="runTimelineDraft" value="1" />
                <button className="brand-primary-button inline-flex items-center gap-2 rounded-sm px-3 py-2 text-sm">
                  <Bot className="h-4 w-4" />
                  Create timeline
                </button>
              </form>
            )}
            <Link href={`/questionnaires/${id}/responses/${responseId}/edit`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
              <Pencil className="h-4 w-4" />
              Edit responses
            </Link>
          </div>
          </div>
        </header>

        <section className="grid gap-x-6 gap-y-3 border-b border-[var(--line)] pb-4 text-sm md:grid-cols-2 xl:grid-cols-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              <UserRound className="h-4 w-4" />
              Respondent
            </div>
            <div className="mt-1 truncate font-semibold">{respondent}</div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              <Mail className="h-4 w-4" />
              Email
            </div>
            <div className="mt-1 truncate font-semibold">{response.respondentEmail || response.clientEmail || "No email captured"}</div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              <FolderKanban className="h-4 w-4" />
              Linked project
            </div>
            <div className="mt-1 truncate font-semibold">{response.projectName || "No linked project"}</div>
            <div className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">{displayClient(response)}</div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              <CalendarDays className="h-4 w-4" />
              {status === "submitted" ? "Submitted" : "Draft saved"}
            </div>
            <div className="mt-1 truncate font-semibold">{formatTimestamp(response.submittedAt ?? response.updatedAt)}</div>
          </div>
        </section>

        {autofillReviewOn && (
          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] shadow-sm">
            <div className="border-b border-[var(--line)] p-5">
              <h2 className="text-lg font-semibold">Suggested changes</h2>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">
                Autofill review (CR-5): nothing below has been written to the project or client yet. Uncheck any field
                to skip it, then apply.
              </p>
              {query.saved === "applied" && (
                <p className="mt-2 rounded-md border border-[var(--brand-brown)] bg-[#fbf6ef] px-3 py-2 text-sm text-[var(--brand-brown)]">
                  Applied. Canonical records now reflect the accepted fields.
                </p>
              )}
              {query.applyError && (
                <p className="mt-2 rounded-md border border-[var(--danger)] bg-[#fdf1f1] px-3 py-2 text-sm text-[var(--danger)]">
                  {query.applyError}
                </p>
              )}
            </div>
            {!hasSuggestedChanges ? (
              <div className="p-5 text-sm text-[var(--ink-muted)]">No suggested changes.</div>
            ) : (
              <form action={`/api/questionnaires/${id}/responses/${responseId}/apply`} method="post">
                <input type="hidden" name="proposalComputedAt" value={proposal?.computedAt ?? ""} />
                <input type="hidden" name="proposalContentHash" value={proposal?.contentHash ?? ""} />
                {proposal!.project.length > 0 && (
                  <div>
                    <div className="studio-caps border-b border-[var(--line-soft)] bg-[var(--paper-2)] px-4 py-2 text-[0.6rem] text-[var(--ink-3)]">Project</div>
                    {proposal!.project.map((change) => (
                      <FieldChangeRow
                        key={`project-${change.field}`}
                        sectionField={change.field}
                        current={change.current}
                        proposed={change.proposed}
                        questionTitle={change.questionTitle}
                        stale={change.stale}
                        checkboxName={change.field}
                      />
                    ))}
                  </div>
                )}
                {proposal!.projectEvent.length > 0 && (
                  <div>
                    <div className="studio-caps border-b border-[var(--line-soft)] bg-[var(--paper-2)] px-4 py-2 text-[0.6rem] text-[var(--ink-3)]">Wedding day event</div>
                    {proposal!.projectEvent.map((change) => (
                      <FieldChangeRow
                        key={`event-${change.field}`}
                        sectionField={change.field}
                        current={change.current}
                        proposed={change.proposed}
                        questionTitle={change.questionTitle}
                        stale={change.stale}
                        checkboxName={change.field}
                      />
                    ))}
                  </div>
                )}
                {proposal!.client.length > 0 && (
                  <div>
                    <div className="studio-caps border-b border-[var(--line-soft)] bg-[var(--paper-2)] px-4 py-2 text-[0.6rem] text-[var(--ink-3)]">Client</div>
                    {proposal!.client.map((change) => (
                      <FieldChangeRow
                        key={`client-${change.field}`}
                        sectionField={change.field}
                        current={change.current}
                        proposed={change.proposed}
                        questionTitle={change.questionTitle}
                        stale={change.stale}
                        checkboxName={change.field}
                      />
                    ))}
                  </div>
                )}
                {proposal!.locations.length > 0 && (
                  <div>
                    <div className="studio-caps border-b border-[var(--line-soft)] bg-[var(--paper-2)] px-4 py-2 text-[0.6rem] text-[var(--ink-3)]">Locations</div>
                    {proposal!.locations.map((change, index) => change.action === "create" ? (
                      <label key={`location-create-${index}`} className="flex items-start gap-3 border-b border-[var(--line-soft)] p-4 last:border-b-0">
                        <input type="checkbox" name="acceptedFields" value={`locations.create.${index}`} defaultChecked className="mt-1 h-4 w-4" />
                        <div className="min-w-0 flex-1 text-sm">
                          <div className="font-semibold">New {change.type.replaceAll("_", " ")} location: {change.proposed.name}</div>
                          {change.proposed.address && <div className="mt-1 text-[var(--ink-muted)]">{change.proposed.address}</div>}
                          {change.proposed.notes && <div className="mt-1 whitespace-pre-wrap text-[var(--ink-muted)]">{change.proposed.notes}</div>}
                        </div>
                      </label>
                    ) : (
                      <div key={`location-update-${change.existingId}`} className="border-b border-[var(--line-soft)] p-4 last:border-b-0">
                        <div className="text-sm font-semibold">Update {change.type.replaceAll("_", " ")} location</div>
                        {change.missing ? (
                          <p className="mt-1 text-xs text-[var(--danger)]">This location was deleted — it will be skipped on apply.</p>
                        ) : (
                          <div className="mt-2 space-y-2">
                            {(["name", "address", "city", "state", "notes"] as const)
                              .filter((field) => change.proposed[field] !== (change.current?.[field] ?? null))
                              .map((field) => (
                                <FieldChangeRow
                                  key={field}
                                  sectionField={field}
                                  current={change.current?.[field] ?? null}
                                  proposed={change.proposed[field] ?? ""}
                                  stale={Boolean(change.liveCurrent && change.liveCurrent[field] !== (change.current?.[field] ?? null))}
                                  checkboxName={`locations.${change.existingId}.${field}`}
                                />
                              ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-end gap-3 p-4">
                  <button className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 text-sm transition">
                    Apply to project
                  </button>
                </div>
              </form>
            )}
          </section>
        )}

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] shadow-sm">
          <div className="border-b border-[var(--line)] p-5">
            <h2 className="text-lg font-semibold">Answers</h2>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">Stored answers from the client-facing questionnaire.</p>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {answers.map((answer) => answer.type === "section" ? (
              <div key={answer.questionId} className="bg-[#fbf9f5] p-5">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">Section</div>
                <h3 className="mt-2 font-semibold uppercase tracking-[0.08em]">{answer.title}</h3>
                {answer.description && <p className="mt-1 text-sm leading-6 text-[var(--ink-muted)]">{answer.description}</p>}
              </div>
            ) : (
              <article key={answer.questionId} className="grid gap-3 p-5 lg:grid-cols-[minmax(240px,0.45fr)_1fr]">
                <div>
                  <h3 className="font-semibold">{answer.title}{answer.required && <span className="ml-1 text-[var(--brand-brown)]">*</span>}</h3>
                  {answer.description && <p className="mt-1 text-sm leading-6 text-[var(--ink-muted)]">{answer.description}</p>}
                  <div className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">{answer.type.replaceAll("_", " ")}</div>
                </div>
                <div className={answer.formattedValue === "No answer" ? "whitespace-pre-wrap text-sm leading-6 text-[var(--ink-muted)]" : "whitespace-pre-wrap text-sm leading-6"}>
                  {answer.formattedValue}
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
