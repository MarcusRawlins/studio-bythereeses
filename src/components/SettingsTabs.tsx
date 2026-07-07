import Link from "next/link";
import { HeartPulse, History, Settings, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// CR-2 (left-nav reorganization), flag SETTINGS_NAV_GROUP. Rendered only when the flag is on —
// see the callers in src/app/settings/page.tsx, src/app/activity/page.tsx,
// src/app/data-health/page.tsx, and src/app/system-status/page.tsx. Purely presentational: no
// route changes, all four URLs are unchanged. Server component (no "use client") — each caller
// already knows which tab is active for its own page, so the active state is passed in as a prop
// rather than derived client-side, matching how ProjectSectionNav / activity's actor filter chips
// keep active-state resolution on the server.
export type SettingsTabKey = "settings" | "activity" | "data-health" | "system-status";

const tabs: Array<{ key: SettingsTabKey; href: string; label: string; icon: LucideIcon }> = [
  { key: "settings", href: "/settings", label: "Settings", icon: Settings },
  { key: "activity", href: "/activity", label: "Activity", icon: History },
  { key: "data-health", href: "/data-health", label: "Data Health", icon: HeartPulse },
  { key: "system-status", href: "/system-status", label: "System Status", icon: ShieldCheck },
];

export function SettingsTabs({ active }: { active: SettingsTabKey }) {
  return (
    <nav className="studio-section-nav mb-5" aria-label="Settings sections">
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            prefetch={false}
            aria-current={isActive ? "page" : undefined}
            className={`studio-section-nav-link ${
              isActive ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--ink)]" : ""
            }`}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
