"use client";
import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Brain, Database, ClipboardCheck, MessageSquareText, FileText, Clock, Sparkles, AlertTriangle, Plus, CheckCircle2 } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip } from "recharts";
import { PageHeader, Button, Badge } from "@/components/ui";
import { KpiCard, SectionHeader, Tabs, InsightCard } from "@/components/ui/enterprise";
import { ChartFrame, ChartTip } from "@/components/charts";
import { axisProps } from "@/components/charts/theme";
import { fmtNum } from "@/lib/utils";
import { loadDemoKnowledgeAction } from "@/app/app/brain/actions";
import type { QueueItem } from "@/engine/brain/review";
import type { BrainSource } from "@/engine/brain/sources";
import { BrainLibrary } from "./brain-library";
import { BrainMemory, BrainReview } from "./brain-memory";
import { BrainAsk, BrainSources } from "./brain-ask";

export type BrainDoc = { id: string; title: string; status: string; version: number; category: string; departmentId: string | null; allowedRoles: string[]; mimeType: string; wordCount: number; supersedesId: string | null; createdAt: string; approvedAt: string | null; reviewEveryDays: number; stale: boolean; canApprove: boolean };
export type BrainFact = { id: string; category: string; subject: string; statement: string; status: string; version: number; supersedesId: string | null; sourceRef: string | null; confidence: string; departmentId: string | null; createdAt: string; approvedAt: string | null; canApprove: boolean };
type Health = { documents: { total: number; approved: number; pending: number; rejected: number; archived: number; words: number }; facts: { total: number; approved: number; pending: number }; stale: { id: string; title: string; approvedAt: string | null; reviewEveryDays: number }[]; coverage: { category: string; documents: number; facts: number }[]; missingCategories: string[] };
export type BrainData = {
  orgName: string; isDemo: boolean; role: string; myDepartmentId: string | null;
  perms: { ingest: boolean; approve: boolean; owner: boolean };
  departments: { id: string; name: string }[];
  health: Health; demoDocCount: number;
  docs: BrainDoc[]; facts: BrainFact[]; queue: QueueItem[]; sources: BrainSource[];
  initial: { tab: string | null; doc: string | null; fact: string | null };
};
export type TabKey = "overview" | "library" | "facts" | "review" | "ask" | "sources";
const TAB_KEYS: TabKey[] = ["overview", "library", "facts", "review", "ask", "sources"];

export const CATEGORY_LABEL: Record<string, string> = { company: "Company", policy: "Policies", procedure: "Procedures", pricing: "Pricing", product: "Products", customer: "Customers", vendor: "Vendors", terminology: "Terminology", goal: "Goals", decision: "Decisions", preference: "Preferences", system: "Systems", general: "General", ai_employee: "AI employee memory" };
export const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

export function BrainCenter({ data }: { data: BrainData }) {
  const router = useRouter(); const pathname = usePathname(); const sp = useSearchParams();
  const fromUrl = sp.get("tab") ?? data.initial.tab;
  const [tab, setTab] = React.useState<TabKey>(TAB_KEYS.includes(fromUrl as TabKey) ? (fromUrl as TabKey) : data.initial.doc ? "library" : "overview");
  React.useEffect(() => { const t = sp.get("tab"); if (t && TAB_KEYS.includes(t as TabKey)) setTab(t as TabKey); }, [sp]);
  const [pasteCategory, setPasteCategory] = React.useState<string | null>(null);
  const go = (t: TabKey) => { setTab(t); const q = new URLSearchParams(sp.toString()); q.set("tab", t); q.delete("doc"); q.delete("fact"); router.replace(`${pathname}?${q}`, { scroll: false }); };
  const deptName = React.useMemo(() => new Map(data.departments.map((d) => [d.id, d.name])), [data.departments]);
  const pendingCount = data.queue.length;

  return (
    <div data-testid="brain-center">
      <PageHeader hero eyebrow="AI Workforce" icon={<Brain size={22} />} title="AI Brain" subtitle={`Your company's memory. Everything ${data.orgName}'s AI employees and assistant know comes from here — and nothing is used until a person approves it.`}
        actions={<>
          {data.perms.ingest && <Button variant="glass" onClick={() => go("library")} data-testid="brain-hero-add"><Plus size={15} />Add knowledge</Button>}
          <Button variant="glass" onClick={() => go("ask")} data-testid="brain-hero-ask"><MessageSquareText size={15} />Ask the Brain</Button>
        </>} />
      <Tabs testid="brain-tabs" value={tab} onChange={go} tabs={[
        { key: "overview", label: "Overview" },
        { key: "library", label: "Library", count: data.docs.filter((d) => d.status !== "archived").length },
        { key: "facts", label: "Business memory", count: data.facts.length },
        ...(data.perms.approve ? [{ key: "review" as const, label: "Review queue", count: pendingCount }] : []),
        { key: "ask", label: "Ask the Brain" },
        { key: "sources", label: "Connected sources" },
      ]} />
      <div role="tabpanel">
        {tab === "overview" && <BrainOverview data={data} onTab={go} onAddCategory={(c) => { setPasteCategory(c); go("library"); }} />}
        {tab === "library" && <BrainLibrary data={data} deptName={deptName} initialDoc={data.initial.doc} pasteCategory={pasteCategory} onPasteConsumed={() => setPasteCategory(null)} />}
        {tab === "facts" && <BrainMemory data={data} deptName={deptName} highlight={data.initial.fact} />}
        {tab === "review" && data.perms.approve && <BrainReview data={data} deptName={deptName} />}
        {tab === "ask" && <BrainAsk data={data} />}
        {tab === "sources" && <BrainSources data={data} />}
      </div>
    </div>
  );
}

function BrainOverview({ data, onTab, onAddCategory }: { data: BrainData; onTab: (t: TabKey) => void; onAddCategory: (c: string) => void }) {
  const h = data.health; const router = useRouter();
  const [loading, setLoading] = React.useState(false); const [msg, setMsg] = React.useState<string | null>(null);
  const covered = h.coverage.filter((c) => c.documents + c.facts > 0).length;
  const rows = h.coverage.map((c) => ({ name: CATEGORY_LABEL[c.category] ?? c.category, documents: c.documents, facts: c.facts })).sort((a, b) => b.documents + b.facts - (a.documents + a.facts));
  const empty = h.documents.total === 0 && h.facts.total === 0;
  async function loadDemo() { setLoading(true); setMsg(null); const r = await loadDemoKnowledgeAction(); setLoading(false); setMsg(r.ok ? `Loaded ${r.created} synthetic documents (approved, audited as synthetic demo content)${r.skipped ? `; ${r.skipped} were already present` : ""}.` : r.error); router.refresh(); }
  return (
    <div data-testid="brain-overview">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 stagger" data-testid="brain-health">
        <KpiCard testid="brain-kpi-docs" label="Approved documents" value={h.documents.approved} format={(n) => fmtNum(n)} accent="purple" icon={<FileText size={16} />} caption={`${fmtNum(h.documents.words)} words the AI can cite`} />
        <KpiCard testid="brain-kpi-facts" label="Approved facts" value={h.facts.approved} format={(n) => fmtNum(n)} accent="indigo" icon={<Database size={16} />} caption={`${h.facts.total} in business memory`} />
        <KpiCard testid="brain-kpi-pending" label="Waiting for review" value={h.documents.pending + h.facts.pending} format={(n) => fmtNum(n)} accent="gold" icon={<ClipboardCheck size={16} />} caption="Not used by AI until approved" />
        <KpiCard testid="brain-kpi-coverage" label="Topics covered" value={covered} format={(n) => `${fmtNum(n)} / ${h.coverage.length}`} accent={covered >= 8 ? "emerald" : "coral"} icon={<CheckCircle2 size={16} />} caption={`${h.stale.length} document${h.stale.length === 1 ? "" : "s"} due for re-review`} />
      </div>

      {empty && (
        <div className="card mt-5 flex flex-col items-start gap-3 p-6 sm:flex-row sm:items-center sm:justify-between" data-testid="brain-empty">
          <div><div className="text-sm font-bold">The Brain is empty</div><p className="mt-1 max-w-xl text-xs text-ink-2">Upload your policies, price sheets and procedures, or let BridgeBox propose facts it already knows (departments, systems, workflows). Your AI employees can only cite what you approve.</p></div>
          <div className="flex flex-wrap gap-2">{data.perms.ingest && <Button onClick={() => onTab("library")} data-testid="brain-empty-upload"><Plus size={15} />Upload documents</Button>}{data.perms.ingest && <Button variant="secondary" onClick={() => onTab("facts")} data-testid="brain-empty-learn"><Sparkles size={15} />Learn from BridgeBox</Button>}</div>
        </div>
      )}

      {data.isDemo && data.perms.owner && h.documents.approved < data.demoDocCount && (
        <div className="card mt-5 flex flex-col gap-3 border-gold/40 bg-gold-soft/30 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="brain-demo-load">
          <div className="text-sm"><Badge tone="gold">Synthetic sample</Badge><span className="ml-2 font-semibold">Load synthetic demo knowledge</span><p className="mt-1 text-xs text-ink-2">Adds {data.demoDocCount} fictional Gulf Coast documents (AP policy, vendor list, PO register, pricing, SLA, onboarding, travel policy, overview, glossary), approved and audited as synthetic demo content. Demo organizations only.</p></div>
          <Button variant="secondary" loading={loading} onClick={loadDemo} data-testid="brain-demo-load-btn">Load demo knowledge</Button>
        </div>
      )}
      {msg && <p className="mt-2 text-xs font-semibold text-ink-2" role="status" data-testid="brain-demo-msg">{msg}</p>}

      <div className="mt-5 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <ChartFrame testid="brain-coverage" title="Coverage by category" subtitle="Approved documents and facts per topic. Empty rows are gaps your AI employees cannot answer about." legend={[{ label: "Documents", color: "var(--color-purple)" }, { label: "Facts", color: "var(--color-cyan)" }]} height={Math.max(260, rows.length * 24)}>
          <div className="h-full" role="img" aria-label={`Coverage: ${rows.map((r) => `${r.name} ${r.documents} documents, ${r.facts} facts`).join("; ")}`}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }} barCategoryGap={4}>
                <CartesianGrid horizontal={false} stroke="var(--color-border)" />
                <XAxis type="number" allowDecimals={false} {...axisProps} />
                <YAxis type="category" dataKey="name" width={96} {...axisProps} />
                <RTooltip cursor={{ fill: "var(--color-surface-2)" }} content={({ active, payload, label }) => <ChartTip active={active} label={label} rows={(payload ?? []).map((p) => ({ name: String(p.name), value: fmtNum(Number(p.value)), color: String(p.color) }))} />} />
                <Bar dataKey="documents" name="Documents" stackId="a" fill="var(--color-purple)" stroke="var(--color-surface)" strokeWidth={2} />
                <Bar dataKey="facts" name="Facts" stackId="a" fill="var(--color-cyan)" stroke="var(--color-surface)" strokeWidth={2} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartFrame>
        <div className="space-y-4">
          <div className="card p-5" data-testid="brain-missing">
            <div className="text-sm font-semibold">Missing topics</div>
            <p className="mt-0.5 text-xs text-ink-2">Nothing approved yet in these categories.</p>
            {h.missingCategories.length ? <div className="mt-3 flex flex-wrap gap-1.5">{h.missingCategories.map((c) => data.perms.ingest
              ? <button key={c} onClick={() => onAddCategory(c)} className="inline-flex items-center gap-1 rounded-lg border border-dashed border-border px-2 py-1 text-xs font-semibold text-ink-2 hover:border-royal hover:text-royal-ink" data-testid={`brain-missing-${c}`}><Plus size={12} />{CATEGORY_LABEL[c] ?? c}</button>
              : <span key={c} className="rounded-lg bg-surface-2 px-2 py-1 text-xs text-ink-2">{CATEGORY_LABEL[c] ?? c}</span>)}</div> : <p className="mt-3 text-xs font-semibold text-emerald-ink">Every category has approved knowledge.</p>}
          </div>
          <div className="card p-5" data-testid="brain-freshness">
            <div className="flex items-center gap-2 text-sm font-semibold"><Clock size={15} className="text-gold-ink" />Freshness</div>
            {h.stale.length ? <ul className="mt-2 space-y-2">{h.stale.slice(0, 6).map((s) => <li key={s.id} className="flex items-start gap-2 text-xs"><AlertTriangle size={13} className="mt-0.5 shrink-0 text-gold-ink" /><span><a className="font-semibold text-royal-ink hover:underline" href={`/app/brain?tab=library&doc=${s.id}`}>{s.title}</a> — approved {fmtDate(s.approvedAt)}, review every {s.reviewEveryDays} days. Publish a new version or re-approve.</span></li>)}</ul>
              : <p className="mt-2 text-xs text-ink-2">No approved document is past its review date.</p>}
          </div>
        </div>
      </div>

      <SectionHeader title="How the Brain stays trustworthy" accent="purple" icon={<Brain size={16} />} />
      <div className="grid gap-3 md:grid-cols-3 stagger">
        <InsightCard title="Nothing is learned silently" body="Uploads, synced facts and AI-employee lessons all wait in the review queue. Corrections create a new version that replaces the old one only when approved." />
        <InsightCard accent="cyan" title="Permissions at retrieval" body="Each answer is built only from documents the asker's role and department may read. Owners can simulate any role on the Ask tab." />
        <InsightCard accent="coral" title="Documents are data, not instructions" body="Text inside your documents can never change an AI employee's permissions or tell it to act — it is isolated as untrusted reference data." />
      </div>
    </div>
  );
}
