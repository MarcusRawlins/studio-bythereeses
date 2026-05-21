import { AppShell } from "@/components/AppShell";
import { ProjectForm } from "@/components/ProjectForm";
import Link from "next/link";

export default function NewProjectPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="border-b border-[var(--line)] pb-5">
          <Link href="/projects" className="text-sm font-semibold transition hover:text-[var(--accent)]">
            Back to projects
          </Link>
          <h1 className="brand-page-title text-4xl">Create Project</h1>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">Add the project and primary client together.</p>
        </header>
        <ProjectForm />
      </div>
    </AppShell>
  );
}
