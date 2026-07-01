import Link from "next/link";
import type { LucideIcon } from "lucide-react";

type AppNavLinkProps = {
  href: string;
  label: string;
  icon: LucideIcon;
  compact?: boolean;
};

export function AppNavLink({ href, label, icon: Icon, compact }: AppNavLinkProps) {
  if (compact) {
    return (
      <Link
        href={href}
        prefetch={false}
        className="studio-secondary-button inline-flex min-h-10 shrink-0 items-center gap-2 px-3 py-2 text-xs font-medium transition"
      >
        <Icon className="h-3.5 w-3.5" />
        {label}
      </Link>
    );
  }

  return (
    <Link
      href={href}
      prefetch={false}
      className="studio-nav-link group flex items-center gap-3 rounded-md border-l-2 px-2.5 py-2.5 text-[13px] font-medium transition"
    >
      <Icon className="h-4 w-4" />
      {label}
    </Link>
  );
}
