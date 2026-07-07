import Link from "next/link";
import { CalendarDays, CalendarRange, ClipboardList, FileSignature, FolderKanban, HeartPulse, History, Inbox, Landmark, LayoutDashboard, MapPin, ReceiptText, Settings, ShieldCheck, SwatchBook, UsersRound } from "lucide-react";
import { AppNavLink } from "./AppNavLink";
import { QuickFind } from "./QuickFind";

const operationsItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/agenda", label: "Agenda", icon: CalendarRange },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/clients", label: "Clients", icon: UsersRound },
  { href: "/finance", label: "Finance", icon: Landmark },
];

const logisticsItems = [
  { href: "/shooting-locations", label: "Locations", icon: MapPin },
  { href: "/scheduler", label: "Scheduler", icon: CalendarDays },
];

const studioItems = [
  { href: "/proposals", label: "Proposals", icon: FileSignature },
  { href: "/invoices", label: "Invoices", icon: ReceiptText },
  { href: "/activity", label: "Activity", icon: History },
  { href: "/data-health", label: "Data Health", icon: HeartPulse },
  { href: "/system-status", label: "System Status", icon: ShieldCheck },
  { href: "/questionnaires", label: "Questionnaires", icon: ClipboardList },
  { href: "/templates", label: "Templates", icon: SwatchBook },
  { href: "/settings", label: "Settings", icon: Settings },
];

const mobileItems = [
  operationsItems[0],
  operationsItems[1],
  operationsItems[2],
  operationsItems[3],
  logisticsItems[1],
  operationsItems[5],
];

// CR-2 (left-nav reorganization), flag SETTINGS_NAV_GROUP. Strict `=== "1"`, dark by default —
// mirrors PROJECT_PROGRESS_TIMELINE (src/app/projects/[id]/page.tsx) / PORTAL_MAGIC_LINK_ENABLED
// (src/app/portal/page.tsx). Flag off returns `studioItems` itself (same reference, same order,
// same 8 items with Settings last) so the sidebar is byte-identical to today. Flag on drops the
// three rarely-used system/ops pages from the top level (they move into a Settings tab strip —
// see SettingsTabs.tsx — and keep their existing URLs) and moves Settings up next to Invoices so
// it is no longer dead last.
export function getStudioNavItems(settingsNavGroupEnabled: boolean) {
  if (!settingsNavGroupEnabled) return studioItems;

  const hiddenAtTopLevel = new Set(["/activity", "/data-health", "/system-status", "/settings"]);
  const settingsItem = studioItems.find((item) => item.href === "/settings")!;
  const remaining = studioItems.filter((item) => !hiddenAtTopLevel.has(item.href));
  const invoicesIndex = remaining.findIndex((item) => item.href === "/invoices");
  const reordered = [...remaining];
  reordered.splice(invoicesIndex + 1, 0, settingsItem);
  return reordered;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const settingsNavGroupEnabled = process.env.SETTINGS_NAV_GROUP === "1";
  const resolvedStudioItems = getStudioNavItems(settingsNavGroupEnabled);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--paper)_94%,transparent)] px-4 py-3 backdrop-blur-xl lg:hidden">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" prefetch={false} className="shrink-0">
            <span className="block">
              <span className="studio-caps block text-[0.55rem] text-[var(--brand-brown)]">The Reeses</span>
              <span className="brand-wordmark block text-xl text-[var(--ink)] sm:text-2xl">STUDIO</span>
            </span>
          </Link>
          <Link href="/projects/new" prefetch={false} className="brand-primary-button inline-flex min-h-10 shrink-0 items-center justify-center gap-2 px-3 py-2 text-xs transition">
            Create
          </Link>
        </div>
        <div className="mt-2.5">
          <QuickFind mobile />
        </div>
        <nav className="studio-scrollbar mt-2.5 flex gap-2 overflow-x-auto pb-1" aria-label="Primary navigation">
          {mobileItems.map((item) => (
            <AppNavLink key={item.href} href={item.href} label={item.label} icon={item.icon} compact />
          ))}
        </nav>
      </header>
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-[var(--line)] bg-[var(--paper)] px-[18px] py-7 lg:flex lg:flex-col">
        <Link href="/" prefetch={false} className="block py-2">
          <span className="block">
            <span className="studio-caps block text-[0.62rem] text-[var(--brand-brown)]">The Reeses</span>
            <span className="brand-wordmark block text-4xl text-[var(--ink)]">STUDIO</span>
          </span>
        </Link>

        <QuickFind />

        <div className="studio-caps mt-6 px-3 text-[0.58rem] text-[var(--brand-brown)]">OPERATIONS</div>
        <nav className="mt-2 space-y-1">
          {operationsItems.map((item) => (
            <AppNavLink key={item.href} href={item.href} label={item.label} icon={item.icon} />
          ))}
        </nav>

        <div className="studio-caps mt-5 px-3 text-[0.58rem] text-[var(--ink-3)]">LOGISTICS</div>
        <nav className="mt-2 space-y-1">
          {logisticsItems.map((item) => (
            <AppNavLink key={item.href} href={item.href} label={item.label} icon={item.icon} />
          ))}
        </nav>

        <div className="studio-caps mt-7 px-3 text-[0.58rem] text-[var(--brand-brown)]">STUDIO</div>
        <nav className="mt-2 space-y-1">
          {resolvedStudioItems.map((item) => (
            <AppNavLink key={item.href} href={item.href} label={item.label} icon={item.icon} />
          ))}
        </nav>

        <div className="mt-auto border-t border-[var(--line-soft)] pt-4">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="grid h-8 w-8 place-items-center rounded-full bg-[var(--brand-brown)] text-xs font-semibold text-white">TR</div>
            <div className="min-w-0">
              <div className="text-sm font-medium">Tyler Reese</div>
              <div className="studio-caps text-[0.52rem] text-[var(--ink-3)]">Warm Operations</div>
            </div>
          </div>
        </div>
      </aside>
      <main className="min-w-0 lg:pl-60">
        <div className="mx-auto min-h-screen w-full max-w-[1420px] px-3 py-4 sm:px-6 sm:py-5 lg:px-10">
          {children}
        </div>
      </main>
    </div>
  );
}
