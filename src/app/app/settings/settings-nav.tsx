"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function SettingsNav({ tabs }: { tabs: { href: string; label: string; testid: string }[] }) {
  const path = usePathname();
  // Structure (business units, locations, department overhead) — added here so the shared settings layout stays untouched.
  if (!tabs.some((t) => t.href === "/app/settings/structure")) tabs = [tabs[0], { href: "/app/settings/structure", label: "Structure", testid: "settings-tab-structure" }, ...tabs.slice(1)].filter(Boolean);
  return (
    <nav className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 scrollbar-thin lg:mx-0 lg:px-0" aria-label="Settings sections" data-testid="settings-nav">
      {tabs.map((t) => { const active = t.href === "/app/settings" ? path === t.href : path.startsWith(t.href); return (
        <Link key={t.href} href={t.href} data-testid={t.testid} className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition", active ? "border-brand font-medium text-brand" : "border-transparent text-ink-2 hover:text-ink")}>{t.label}</Link>
      ); })}
    </nav>
  );
}
