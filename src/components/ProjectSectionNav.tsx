import type { LucideIcon } from "lucide-react";

export type ProjectSectionNavItem = {
  id: string;
  label: string;
  icon?: LucideIcon;
};

export function ProjectSectionNav({ items }: { items: ProjectSectionNavItem[] }) {
  return (
    <nav className="studio-section-nav" aria-label="Project sections">
      {items.map((item) => (
        <a key={item.id} href={`#${item.id}`} className="studio-section-nav-link">
          {item.icon ? <item.icon className="h-3.5 w-3.5 shrink-0" /> : null}
          <span>{item.label}</span>
        </a>
      ))}
    </nav>
  );
}