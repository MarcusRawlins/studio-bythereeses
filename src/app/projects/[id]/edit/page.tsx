import { AppShell } from "@/components/AppShell";
import { ProjectEditForm } from "@/components/ProjectEditForm";
import { getProject } from "@/lib/crm";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function EditProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getProject(id);
  if (!data) notFound();

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="border-b border-[var(--line)] pb-5">
          <Link href={`/projects/${data.project.id}`} className="text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">
            Back to project
          </Link>
          <h1 className="brand-page-title mt-3 text-4xl">Edit Project</h1>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">{data.project.name}</p>
        </header>

        <ProjectEditForm project={data.project} />
      </div>
    </AppShell>
  );
}
