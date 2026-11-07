"use client";
/** Consulting-portal shell: same look as AppShell, admin navigation (Clients, Pipeline, Projects, Billing, Reports, Team). */
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { Building2, Lightbulb, Briefcase, CreditCard, FileText, Users, Menu, X, LogOut, ArrowLeftRight } from "lucide-react";
import { cn } from "@/lib/utils";

export const ADMIN_NAV = [
  { href: "/admin", label: "Clients", icon: Building2, testid: "admin-nav-clients" },
  { href: "/admin/pipeline", label: "Pipeline", icon: Lightbulb, testid: "admin-nav-pipeline" },
  { href: "/admin/projects", label: "Projects", icon: Briefcase, testid: "admin-nav-projects" },
  { href: "/admin/billing", label: "Billing", icon: CreditCard, testid: "admin-nav-billing" },
  { href: "/admin/reports", label: "Reports", icon: FileText, testid: "admin-nav-reports" },
  { href: "/admin/team", label: "Team", icon: Users, testid: "admin-nav-team" },
];

export function AdminShell({ email, role, consultancyName, primaryColor, children }: { email: string; role: string; consultancyName: string; primaryColor?: string; children: React.ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = React.useState(false);
  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5 px-2 py-2" aria-label="Consulting portal">
      {ADMIN_NAV.map((n) => { const active = n.href === "/admin" ? path === "/admin" || path.startsWith("/admin/clients") : path.startsWith(n.href); return (
        <Link key={n.href} href={n.href} data-testid={n.testid} onClick={() => setOpen(false)} className={cn("flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition", active ? "bg-brand-soft font-medium text-brand" : "text-ink-2 hover:bg-surface-2 hover:text-ink")}>
          <n.icon size={17} className="shrink-0" />{n.label}
        </Link>); })}
      <Link href="/app" data-testid="admin-nav-client-app" onClick={() => setOpen(false)} className="mt-2 flex items-center gap-2.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-ink-2 hover:bg-surface-2"><ArrowLeftRight size={17} />Client app</Link>
    </nav>
  );
  const brandBlock = (
    <div className="flex items-center gap-2 px-4 py-4"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">B</div><div className="leading-tight"><div className="text-sm font-semibold">BridgeBox</div><div className="text-[10px] uppercase tracking-wider text-ink-3">Consulting Portal</div></div></div>
  );
  return (
    <div className="flex min-h-screen" style={primaryColor ? ({ "--color-brand": primaryColor } as React.CSSProperties) : undefined}>
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-surface lg:flex" data-testid="admin-sidebar">
        {brandBlock}
        {nav}
        <div className="border-t border-border p-3 text-xs text-ink-2"><div className="truncate font-medium text-ink">{email}</div><div className="flex items-center justify-between"><span className="capitalize">{role}</span><button onClick={() => signOut({ callbackUrl: "/login" })} className="flex items-center gap-1 hover:text-ink" data-testid="admin-logout"><LogOut size={13} />Sign out</button></div></div>
      </aside>
      {open && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setOpen(false)} />}
      <aside className={cn("fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-surface transition-transform lg:hidden", open ? "translate-x-0" : "-translate-x-full")} data-testid="admin-mobile-sidebar">
        <div className="flex items-center justify-between px-4 py-3"><span className="text-sm font-semibold">Consulting Portal</span><button onClick={() => setOpen(false)} aria-label="Close menu"><X size={20} /></button></div>
        {nav}
        <div className="border-t border-border p-3 text-xs"><button onClick={() => signOut({ callbackUrl: "/login" })} className="flex items-center gap-1"><LogOut size={13} />Sign out</button></div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:px-6">
          <button className="rounded-md p-1.5 hover:bg-surface-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu" data-testid="admin-menu-button"><Menu size={20} /></button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="admin-consultancy-name">{consultancyName}</div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-6">{children}</main>
      </div>
    </div>
  );
}
