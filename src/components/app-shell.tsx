"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  LayoutDashboard, BarChart3, Users, Building2, Workflow, Network, Lightbulb, Bot, Wand2, Calculator, PiggyBank, Shuffle, Scale, ShieldAlert,
  Route, FileText, ClipboardCheck, MessageSquareText, Briefcase, MapPin, UserCog, Plug, Radar, ScrollText, CreditCard, Settings, ShieldCheck,
  Menu, X, LogOut, Search, Presentation, Sun, Moon, ChevronDown, PanelLeftClose, PanelLeftOpen, Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { can, type Role } from "@/lib/rbac";
import type { Ctx } from "@/lib/auth";

type Icon = React.ComponentType<{ size?: number; className?: string }>;
export type NavItem = { href: string; label: string; icon: Icon; perm?: Parameters<typeof can>[1]; testid: string; consultancyOnly?: boolean; desc?: string };
export type NavGroup = { key: string; label: string; items: NavItem[] };

/** The 26 enterprise modules (+ employee Trust page), grouped. Every href resolves to a fully built page. */
export const NAV_GROUPS: NavGroup[] = [
  { key: "command", label: "Command", items: [
    { href: "/app", label: "Executive Command Center", icon: LayoutDashboard, testid: "nav-executive", desc: "Org-wide financial & operational intelligence" },
    { href: "/app/business", label: "Business Intelligence", icon: BarChart3, perm: "workflows:read", testid: "nav-business", desc: "Business performance analysis" },
    { href: "/app/evaluation", label: "Business Evaluation", icon: ClipboardCheck, perm: "workflows:read", testid: "nav-evaluation", desc: "AI readiness & transformation score" },
  ] },
  { key: "intel", label: "Intelligence", items: [
    { href: "/app/employees", label: "Workforce Intelligence", icon: Users, perm: "employees:read", testid: "nav-employees" },
    { href: "/app/departments", label: "Department Intelligence", icon: Building2, perm: "workflows:read", testid: "nav-departments" },
    { href: "/app/process-mining", label: "Process Mining", icon: Network, perm: "workflows:read", testid: "nav-process-mining" },
    { href: "/app/workflows", label: "Workflow Explorer", icon: Workflow, perm: "workflows:read", testid: "nav-workflows" },
    { href: "/app/benchmarking", label: "Benchmarking", icon: Scale, perm: "workflows:read", testid: "nav-benchmarking" },
  ] },
  { key: "automate", label: "Automation", items: [
    { href: "/app/opportunities", label: "AI Opportunity Center", icon: Lightbulb, perm: "opportunities:read", testid: "nav-opportunities" },
    { href: "/app/agents", label: "AI Agent Command Center", icon: Bot, perm: "agents:read", testid: "nav-agents" },
    { href: "/app/automation", label: "Automation Studio", icon: Wand2, perm: "agents:read", testid: "nav-automation" },
  ] },
  { key: "finance", label: "Finance & Proof", items: [
    { href: "/app/finance", label: "Financial Intelligence", icon: Calculator, perm: "finance:read", testid: "nav-finance" },
    { href: "/app/savings", label: "ROI & Savings Center", icon: PiggyBank, perm: "finance:read", testid: "nav-savings" },
    { href: "/app/reports", label: "Executive Reports", icon: FileText, perm: "finance:read", testid: "nav-reports" },
  ] },
  { key: "transform", label: "Transformation", items: [
    { href: "/app/roadmap", label: "Transformation Roadmap", icon: Route, perm: "opportunities:read", testid: "nav-roadmap" },
    { href: "/app/transformation", label: "Organizational Transformation", icon: Shuffle, perm: "finance:read", testid: "nav-transformation" },
    { href: "/app/risk", label: "Risk & Compliance", icon: ShieldAlert, perm: "workflows:read", testid: "nav-risk" },
    { href: "/app/assistant", label: "AI Strategy Advisor", icon: MessageSquareText, perm: "workflows:read", testid: "nav-assistant" },
  ] },
  { key: "admin", label: "Administration", items: [
    { href: "/admin", label: "Client Organizations", icon: Briefcase, consultancyOnly: true, testid: "nav-admin" },
    { href: "/app/settings/structure", label: "Locations & Business Units", icon: MapPin, perm: "org:manage", testid: "nav-structure" },
    { href: "/app/settings/members", label: "Employees & Roles", icon: UserCog, perm: "members:invite", testid: "nav-members" },
    { href: "/app/integrations", label: "Integrations", icon: Plug, perm: "org:manage", testid: "nav-integrations" },
    { href: "/app/collection", label: "Desktop Collectors", icon: Radar, perm: "collectors:manage", testid: "nav-collection" },
    { href: "/app/settings/audit", label: "Security & Audit Logs", icon: ScrollText, perm: "audit:read", testid: "nav-audit" },
    { href: "/app/billing", label: "Subscription & Billing", icon: CreditCard, perm: "org:billing", testid: "nav-billing" },
    { href: "/app/settings", label: "Enterprise Settings", icon: Settings, perm: "org:manage", testid: "nav-settings" },
    { href: "/app/trust", label: "Trust & Privacy", icon: ShieldCheck, testid: "nav-trust" },
  ] },
];
/** Flat list (kept for tests & search). */
export const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

function isActive(path: string, href: string) {
  if (href === "/app") return path === "/app";
  if (href === "/app/settings") return path === "/app/settings" || (path.startsWith("/app/settings/") && !["/app/settings/structure", "/app/settings/members", "/app/settings/audit"].some((p) => path.startsWith(p)));
  return path === href || path.startsWith(href + "/");
}

export function useTheme() {
  const [theme, setThemeState] = React.useState<"light" | "dark" | "present">("light");
  React.useEffect(() => { setThemeState((document.documentElement.getAttribute("data-theme") as "light" | "dark" | "present") ?? "light"); }, []);
  const setTheme = React.useCallback((t: "light" | "dark" | "present") => { document.documentElement.setAttribute("data-theme", t); try { if (t !== "present") localStorage.setItem("bb-theme", t); } catch {} setThemeState(t); }, []);
  return { theme, setTheme };
}

export function AppShell({ ctx, orgs, isDemo, branding, children }: { ctx: Ctx; orgs: { id: string; name: string; kind: string; role: string }[]; isDemo: boolean; branding: { primaryColor?: string; logoUrl?: string; reportName?: string }; children: React.ReactNode }) {
  const path = usePathname(); const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const [closedGroups, setClosedGroups] = React.useState<string[]>([]);
  const { theme, setTheme } = useTheme();
  React.useEffect(() => { try { setCollapsed(localStorage.getItem("bb-nav-collapsed") === "1"); setClosedGroups(JSON.parse(localStorage.getItem("bb-nav-closed") ?? "[]")); } catch {} }, []);
  const toggleCollapsed = () => { const v = !collapsed; setCollapsed(v); try { localStorage.setItem("bb-nav-collapsed", v ? "1" : "0"); } catch {} };
  const toggleGroup = (k: string) => { const v = closedGroups.includes(k) ? closedGroups.filter((x) => x !== k) : [...closedGroups, k]; setClosedGroups(v); try { localStorage.setItem("bb-nav-closed", JSON.stringify(v)); } catch {} };
  const isConsultancy = orgs.some((o) => o.kind === "consultancy" && ["owner", "admin", "consultant"].includes(o.role));
  const visible = (n: NavItem) => (n.consultancyOnly ? isConsultancy : !n.perm || can(ctx.role as Role, n.perm));
  async function switchOrg(id: string) { await fetch("/api/org/switch", { method: "POST", body: JSON.stringify({ orgId: id }), headers: { "content-type": "application/json" } }); router.push("/app"); router.refresh(); }

  const nav = (mobile: boolean) => (
    <nav className="scrollbar-thin flex-1 overflow-y-auto px-2.5 pb-4" aria-label="Main">
      {NAV_GROUPS.map((g) => {
        const items = g.items.filter(visible); if (!items.length) return null;
        const closed = !mobile && !collapsed && closedGroups.includes(g.key);
        return (
          <div key={g.key} className="mt-3">
            {!collapsed || mobile ? (
              <button onClick={() => toggleGroup(g.key)} className="flex w-full items-center justify-between px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[.14em] text-slate-400 hover:text-slate-200" aria-expanded={!closed}>
                {g.label}<ChevronDown size={12} className={cn("transition", closed && "-rotate-90")} />
              </button>
            ) : <div className="mx-3 my-2 h-px bg-white/10" />}
            {!closed && <div className="mt-1 space-y-0.5">
              {items.map((n) => { const active = isActive(path, n.href); return (
                <Link key={n.href} href={n.href} data-testid={n.testid} onClick={() => setOpen(false)} title={collapsed && !mobile ? n.label : undefined} aria-current={active ? "page" : undefined}
                  className={cn("group relative flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13px] font-medium transition",
                    active ? "bg-gradient-to-r from-royal/90 to-indigo/80 text-white shadow-[0_8px_20px_-10px_rgba(37,99,235,.9)]" : "text-slate-300 hover:bg-white/[.06] hover:text-white",
                    collapsed && !mobile && "justify-center px-0")}>
                  <n.icon size={17} className={cn("shrink-0", active ? "text-white" : "text-slate-400 group-hover:text-cyan-300")} />
                  {(!collapsed || mobile) && <span className="truncate">{n.label}</span>}
                </Link>); })}
            </div>}
          </div>
        );
      })}
    </nav>
  );
  const brand = (
    <div className="flex items-center gap-2.5 px-4 pb-2 pt-5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[conic-gradient(from_200deg,#2563eb,#8b5cf6,#06b6d4,#2563eb)] font-display text-sm font-extrabold text-white shadow-[0_8px_24px_-8px_rgba(139,92,246,.8)]">B</div>
      {!collapsed && <div className="min-w-0 leading-tight"><div className="font-display text-[15px] font-extrabold tracking-tight text-white">BridgeBox</div><div className="truncate text-[10px] font-semibold uppercase tracking-[.16em] text-cyan-300/90">Workforce Intelligence</div></div>}
    </div>
  );
  const orgSelect = orgs.length > 1 && (
    <div className={cn("px-3 pb-1 pt-2", collapsed && "hidden")}>
      <label className="sr-only" htmlFor="org-switcher">Organization</label>
      <select id="org-switcher" data-testid="org-switcher" value={ctx.orgId} onChange={(e) => switchOrg(e.target.value)} className="h-9 w-full rounded-xl border border-white/10 bg-white/[.06] px-2.5 text-xs font-semibold text-white focus:border-cyan-400 [&>option]:text-ink">
        {orgs.map((o) => <option key={o.id} value={o.id}>{o.kind === "consultancy" ? "◆ " : ""}{o.name}</option>)}
      </select>
    </div>
  );
  const userBox = (
    <div className={cn("border-t border-white/10 p-3 text-xs text-slate-300", collapsed && "px-1")}>
      {!collapsed && <div className="truncate font-semibold text-white">{ctx.email}</div>}
      <div className={cn("mt-0.5 flex items-center justify-between", collapsed && "flex-col gap-2")}>
        {!collapsed && <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cyan-200">{ctx.role}</span>}
        <button onClick={() => signOut({ callbackUrl: "/login" })} className="flex items-center gap-1 hover:text-white" data-testid="logout" title="Sign out"><LogOut size={13} />{!collapsed && "Sign out"}</button>
      </div>
    </div>
  );

  return (
    <div className="bg-app flex min-h-screen" style={branding.primaryColor ? ({ "--color-brand": branding.primaryColor } as React.CSSProperties) : undefined}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-royal focus:px-3 focus:py-2 focus:text-white">Skip to content</a>
      <aside className={cn("bg-sidebar sticky top-0 hidden h-screen shrink-0 flex-col transition-[width] lg:flex no-print", collapsed ? "w-[72px]" : "w-[264px]")} data-testid="sidebar">
        {brand}{orgSelect}{nav(false)}
        <button onClick={toggleCollapsed} className="mx-3 mb-2 flex items-center justify-center gap-2 rounded-lg py-1.5 text-[11px] font-semibold text-slate-400 hover:bg-white/5 hover:text-white" data-testid="nav-collapse">{collapsed ? <PanelLeftOpen size={15} /> : <><PanelLeftClose size={15} />Collapse</>}</button>
        {userBox}
      </aside>
      {open && <div className="fixed inset-0 z-40 bg-midnight/60 backdrop-blur-sm lg:hidden" onClick={() => setOpen(false)} />}
      <aside className={cn("bg-sidebar fixed inset-y-0 left-0 z-50 flex w-[290px] flex-col transition-transform lg:hidden", open ? "translate-x-0" : "-translate-x-full")} data-testid="mobile-sidebar" aria-hidden={!open}>
        <div className="flex items-center justify-between pr-3">{brand}<button onClick={() => setOpen(false)} aria-label="Close menu" className="mt-3 rounded-lg p-1.5 text-white hover:bg-white/10"><X size={20} /></button></div>
        {orgSelect}{nav(true)}{userBox}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border/70 bg-surface/80 px-3 backdrop-blur-xl sm:gap-3 lg:px-6 no-print">
          <button className="rounded-lg p-2 hover:bg-surface-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu" data-testid="menu-button"><Menu size={20} /></button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-semibold uppercase tracking-[.14em] text-ink-3">{branding.reportName ?? "Enterprise Transformation Command Center"}</div>
            <div className="truncate font-display text-sm font-bold sm:text-[15px]">{ctx.orgName}</div>
          </div>
          <Link href="/app/search" className="hidden h-9 items-center gap-2 rounded-xl border border-border bg-surface px-3 text-xs text-ink-2 hover:bg-surface-2 md:flex" data-testid="nav-search"><Search size={14} />Search workflows, people, agents…</Link>
          <Link href="/app/search" className="rounded-xl border border-border p-2 hover:bg-surface-2 md:hidden" aria-label="Search" data-testid="nav-search-mobile"><Search size={16} /></Link>
          <Link href="/app/assistant" className="hidden h-9 items-center gap-1.5 rounded-xl bg-purple-soft px-3 text-xs font-semibold text-purple-ink hover:brightness-95 sm:flex" data-testid="top-assistant"><Sparkles size={14} />AI Advisor</Link>
          <Link href="/present" className="flex h-9 items-center gap-1.5 rounded-xl bg-[linear-gradient(135deg,#071426,#13235a)] px-3 text-xs font-semibold text-white shadow-sm hover:brightness-125" data-testid="top-present"><Presentation size={14} /><span className="hidden sm:inline">Present</span></Link>
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="rounded-xl border border-border p-2 text-ink-2 hover:bg-surface-2" aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} data-testid="theme-toggle">{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</button>
        </header>
        {isDemo && <div className="no-print bg-[linear-gradient(90deg,rgba(245,158,11,.14),rgba(245,158,11,.06))] px-4 py-1.5 text-center text-[11px] font-semibold text-gold-ink" data-testid="demo-banner">Synthetic demo data — this organization&apos;s activity, people and costs are generated for demonstration and testing only.</div>}
        <main id="main" className="mx-auto w-full max-w-[1440px] flex-1 px-3 py-5 sm:px-5 lg:px-8 lg:py-7">{children}</main>
      </div>
    </div>
  );
}
