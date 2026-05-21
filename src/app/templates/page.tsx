import { AppShell } from "@/components/AppShell";
import { createTemplateAction, deleteTemplateAction, listTemplates, updateTemplateAction } from "@/lib/templates";
import { CalendarClock, ClipboardList, Mail, Pencil, Plus, Trash2 } from "lucide-react";

export const dynamic = "force-dynamic";

const typeLabels: Record<string, string> = {
  email: "Email",
  questionnaire: "Questionnaire",
  contract: "Contract",
  workflow: "Workflow",
};

function countByType(templates: Awaited<ReturnType<typeof listTemplates>>, type: string) {
  return templates.filter((template) => template.type === type).length;
}

function TemplateFields({
  template,
}: {
  template?: Awaited<ReturnType<typeof listTemplates>>[number];
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {template && <input type="hidden" name="templateId" value={template.id} />}
      <label className="space-y-1.5 text-sm font-medium">
        Type
        <select name="type" defaultValue={template?.type ?? "email"} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
          <option value="email">Email</option>
          <option value="questionnaire">Questionnaire</option>
          <option value="contract">Contract</option>
          <option value="workflow">Workflow rule</option>
        </select>
      </label>
      <label className="space-y-1.5 text-sm font-medium">
        Status
        <select name="status" defaultValue={template?.status ?? "active"} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
          <option value="active">Active</option>
          <option value="draft">Draft</option>
          <option value="archived">Archived</option>
        </select>
      </label>
      <label className="space-y-1.5 text-sm font-medium">
        Name
        <input name="name" defaultValue={template?.name ?? ""} placeholder="Inquiry follow-up" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
      </label>
      <label className="space-y-1.5 text-sm font-medium">
        Trigger
        <input name="trigger" defaultValue={template?.trigger ?? ""} placeholder="2 days after inquiry" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
      </label>
      <label className="space-y-1.5 text-sm font-medium md:col-span-2">
        Subject
        <input name="subject" defaultValue={template?.subject ?? ""} placeholder="Only needed for email templates" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
      </label>
      <label className="space-y-1.5 text-sm font-medium md:col-span-2">
        Body / Notes
        <textarea name="body" defaultValue={template?.body ?? ""} rows={5} placeholder="Template content, questionnaire outline, or workflow description." className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
      </label>
    </div>
  );
}

export default async function TemplatesPage() {
  const templates = await listTemplates();

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 sm:flex-row sm:items-end">
          <div>
            <h1 className="brand-page-title text-4xl">Templates</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">Email, questionnaire, and scheduled workflow templates for repeatable client communication.</p>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <Mail className="h-4 w-4" />
              Email templates
            </div>
            <div className="mt-3 text-3xl font-semibold">{countByType(templates, "email")}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Reusable messages for project stages and dates.</p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <ClipboardList className="h-4 w-4" />
              Questionnaire templates
            </div>
            <div className="mt-3 text-3xl font-semibold">{countByType(templates, "questionnaire")}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Forms that feed timelines, lists, and writing workflows.</p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <CalendarClock className="h-4 w-4" />
              Workflow rules
            </div>
            <div className="mt-3 text-3xl font-semibold">{countByType(templates, "workflow")}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Date-based reminders and sends to build next.</p>
          </div>
        </section>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
          <details>
            <summary className="flex cursor-pointer list-none items-center gap-2 text-lg font-semibold">
              <Plus className="h-4 w-4" />
              Create template
            </summary>
            <form action={createTemplateAction} className="mt-5 rounded-md border border-[var(--line)] bg-[#faf7f1] p-4">
              <TemplateFields />
              <button className="brand-primary-button mt-4 inline-flex items-center gap-2 rounded-sm px-4 py-2.5 transition">
                <Plus className="h-4 w-4" />
                Create template
              </button>
            </form>
          </details>
        </section>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Template library</h2>
          <div className="mt-4 divide-y divide-[var(--line)]">
            {templates.map((template) => (
              <details key={template.id} className="group py-4">
                <summary className="grid cursor-pointer list-none gap-3 md:grid-cols-[1fr_160px_110px] md:items-center">
                  <div>
                    <div className="font-semibold">{template.name}</div>
                    <div className="mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">{template.trigger || "Manual"}</div>
                    <p className="mt-2 line-clamp-2 text-sm leading-6 text-[var(--ink-muted)]">{template.body}</p>
                  </div>
                  <div className="text-sm text-[var(--ink-muted)]">{typeLabels[template.type] ?? template.type}</div>
                  <span className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold">
                    <Pencil className="h-4 w-4" />
                    Edit
                  </span>
                </summary>
                <div className="mt-4 rounded-md border border-[var(--line)] bg-[#faf7f1] p-4">
                  <form action={updateTemplateAction}>
                    <TemplateFields template={template} />
                    <button className="brand-primary-button mt-4 inline-flex items-center gap-2 rounded-sm px-4 py-2.5 transition">
                      <Pencil className="h-4 w-4" />
                      Save template
                    </button>
                  </form>
                  <form action={deleteTemplateAction} className="mt-3">
                    <input type="hidden" name="templateId" value={template.id} />
                    <button className="inline-flex items-center gap-2 rounded-sm border border-[var(--danger)] px-3 py-2 text-sm font-semibold text-[var(--danger)] transition hover:bg-[var(--danger)] hover:text-white">
                      <Trash2 className="h-4 w-4" />
                      Delete template
                    </button>
                  </form>
                </div>
              </details>
            ))}
            {!templates.length && <div className="py-8 text-sm text-[var(--ink-muted)]">No templates yet.</div>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
