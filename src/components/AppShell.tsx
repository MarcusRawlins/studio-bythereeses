import Image from "next/image";
import Link from "next/link";
import { CalendarDays, ClipboardList, FileSignature, FolderKanban, LayoutDashboard, ReceiptText, Settings, SwatchBook, UsersRound } from "lucide-react";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/clients", label: "Clients", icon: UsersRound },
  { href: "/proposals", label: "Proposals", icon: FileSignature },
  { href: "/invoices", label: "Invoices", icon: ReceiptText },
  { href: "/questionnaires", label: "Questionnaires", icon: ClipboardList },
  { href: "/templates", label: "Templates", icon: SwatchBook },
  { href: "/scheduler", label: "Scheduler", icon: CalendarDays },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-[var(--line)] bg-[var(--surface)] px-5 py-6 lg:block">
        <Link href="/" prefetch={false} className="block py-2">
          <Image
            src="/brand/alex-tyler-logo.png"
            alt="Alex & Tyler"
            width={210}
            height={70}
            priority
            className="h-auto w-40"
          />
        </Link>
        <nav className="mt-10 space-y-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-[var(--ink-muted)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="lg:pl-64">
        <div className="mx-auto min-h-screen w-full max-w-7xl px-5 py-5 sm:px-8 lg:px-10">
          {children}
        </div>
      </main>
    </div>
  );
}
