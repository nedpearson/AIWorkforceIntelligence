"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { LayoutDashboard, Network, Users, Lightbulb, Bot, Calculator, Radar, Settings, Building2, Menu, X, LogOut, FileText, Search, ShieldCheck, MessageSquare, Briefcase } from "lucide-react";
import { cn } from "@/lib/utils";
import { can, type Role } from "@/lib/rbac";
import type { Ctx } from "@/lib/auth";

export type NavItem = { href: string; label: string; icon: React.ComponentType<{ size?: number; className?: string }>; perm?: Parameters<typeof can>[1]; testid: string };
export const NAV: NavItem[] = [
  { href: "/app", label: "Executive Summary", icon: LayoutDashboard, testid: "nav-executive" },
  { href: "/app/departments", label: "Departments", icon: Building2, perm: "workflows:read", testid: "nav-departments" },
  { href: "/app/employees", label: "People", icon: Users, perm: "employees:read", testid: "nav-employees" },
  { href: "/app/workflows", label: "Workflows", icon: Network, perm: "workflows:read", testid: "nav-workflows" },
  { href: "/app/opportunities", label: "Opportunities", icon: Lightbulb, perm: "opportunities:read", testid: "nav-opportunities" },
  { href: "/app/agents", label: "AI Agents", icon: Bot, perm: "agents:read", testid: "nav-agents" },
  { href: "/app/finance", label: "Financial Model", icon: Calculator, perm: "finance:read", testid: "nav-finance" },
  { href: "/app/reports", label: "Reports", icon: FileText, perm: "finance:read", testid: "nav-reports" },
  { href: "/app/collection", label: "Data Collection", icon: Radar, perm: "collectors:manage", testid: "nav-collection" },
  { href: "/app/assistant", label: "Ask BridgeBox", icon: MessageSquare, perm: "workflows:read", testid: "nav-assistant" },
  { href: "/app/settings", label: "Settings", icon: Settings, perm: "org:manage", testid: "nav-settings" },
  { href: "/app/trust", label: "Trust & Privacy", icon: ShieldCheck, testid: "nav-trust" },
];

export function AppShell({ ctx, orgs, isDemo, branding, children }: { ctx: Ctx; orgs: { id: string; name: string; kind: string; role: string }[]; isDemo: boolean; branding: { primaryColor?: string; logoUrl?: string }; children: React.ReactNode }) {
  const path = usePathname(); const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const items = NAV.filter((n) => !n.perm || can(ctx.role as Role, n.perm));
  const isConsultancy = orgs.some((o) => o.kind === "consultancy" && ["owner", "admin", "consultant"].includes(o.role));
  async function switchOrg(id: string) { await fetch("/api/org/switch", { method: "POST", body: JSON.stringify({ orgId: id }), headers: { "content-type": "application/json" } }); router.push("/app"); router.refresh(); }
  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5 px-2 py-2" aria-label="Main">
      {items.map((n) => { const active = n.href === "/app" ? path === "/app" : path.startsWith(n.href); return (
        <Link key={n.href} href={n.href} data-testid={n.testid} onClick={() => setOpen(false)} className={cn("flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition", active ? "bg-brand-soft font-medium text-brand" : "text-ink-2 hover:bg-surface-2 hover:text-ink")}>
          <n.icon size={17} className="shrink-0" />{n.label}
        </Link>); })}
      {isConsultancy && <Link href="/admin" data-testid="nav-admin" onClick={() => setOpen(false)} className={cn("mt-2 flex items-center gap-2.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm", path.startsWith("/admin") ? "bg-brand-soft text-brand" : "text-ink-2 hover:bg-surface-2")}><Briefcase size={17} />Consulting Portal</Link>}
    </nav>
  );
  return (
    <div className="flex min-h-screen" style={branding.primaryColor ? ({ "--color-brand": branding.primaryColor } as React.CSSProperties) : undefined}>
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-surface lg:flex" data-testid="sidebar">
        <div className="flex items-center gap-2 px-4 py-4"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">B</div><div className="leading-tight"><div className="text-sm font-semibold">BridgeBox</div><div className="text-[10px] uppercase tracking-wider text-ink-3">Workforce Intelligence</div></div></div>
        <OrgSwitcher ctx={ctx} orgs={orgs} onSwitch={switchOrg} />
        {nav}
        <div className="border-t border-border p-3 text-xs text-ink-2"><div className="truncate font-medium text-ink">{ctx.email}</div><div className="flex items-center justify-between"><span className="capitalize">{ctx.role}</span><button onClick={() => signOut({ callbackUrl: "/login" })} className="flex items-center gap-1 hover:text-ink" data-testid="logout"><LogOut size={13} />Sign out</button></div></div>
      </aside>
      {open && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setOpen(false)} />}
      <aside className={cn("fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-surface transition-transform lg:hidden", open ? "translate-x-0" : "-translate-x-full")} data-testid="mobile-sidebar">
        <div className="flex items-center justify-between px-4 py-3"><span className="text-sm font-semibold">BridgeBox</span><button onClick={() => setOpen(false)} aria-label="Close menu"><X size={20} /></button></div>
        <OrgSwitcher ctx={ctx} orgs={orgs} onSwitch={switchOrg} />
        {nav}
        <div className="border-t border-border p-3 text-xs"><button onClick={() => signOut({ callbackUrl: "/login" })} className="flex items-center gap-1"><LogOut size={13} />Sign out</button></div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:px-6">
          <button className="rounded-md p-1.5 hover:bg-surface-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu" data-testid="menu-button"><Menu size={20} /></button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium">{ctx.orgName}</div>
          <Link href="/app/search" className="flex h-8 items-center gap-2 rounded-lg border border-border px-3 text-xs text-ink-2 hover:bg-surface-2" data-testid="nav-search"><Search size={14} /><span className="hidden sm:inline">Search workflows & people</span></Link>
        </header>
        {isDemo && <div className="bg-warn-soft px-4 py-1.5 text-center text-[11px] font-medium text-warn" data-testid="demo-banner">Synthetic demo data — this organization&apos;s activity, people and costs are generated for demonstration and testing only.</div>}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-6">{children}</main>
      </div>
    </div>
  );
}
function OrgSwitcher({ ctx, orgs, onSwitch }: { ctx: Ctx; orgs: { id: string; name: string; kind: string }[]; onSwitch: (id: string) => void }) {
  if (orgs.length < 2) return null;
  return (
    <div className="px-3 pb-2">
      <select data-testid="org-switcher" value={ctx.orgId} onChange={(e) => onSwitch(e.target.value)} className="h-8 w-full rounded-lg border border-border bg-surface-2 px-2 text-xs">
        {orgs.map((o) => <option key={o.id} value={o.id}>{o.kind === "consultancy" ? "⚙ " : ""}{o.name}</option>)}
      </select>
    </div>
  );
}
