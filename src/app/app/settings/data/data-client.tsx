"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Download, Trash2, Broom } from "lucide-react";
import { Button, Card, CardHeader, Input, Modal, Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { deleteAllActivityEvents, exportOrgData, runRetentionNow } from "../actions";

type Stats = { retentionDays: number; orgName: string; total: number; oldest: string | null; newest: string | null; expired: number; cutoff: string; consents: number };
const date = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-US", { dateStyle: "medium" }) : "—");

export function DataPrivacyClient({ stats, isOwner }: { stats: Stats; isOwner: boolean }) {
  const router = useRouter();
  const [confirm, setConfirm] = React.useState(false); const [typed, setTyped] = React.useState("");
  const [busy, setBusy] = React.useState(""); const [flash, setFlash] = React.useState<{ ok: boolean; text: string } | null>(null);
  async function sweep() { setBusy("sweep"); const r = await runRetentionNow(); setBusy(""); setFlash(r.ok ? { ok: true, text: `Retention sweep deleted ${r.deleted.toLocaleString("en-US")} events older than ${date(r.cutoff)}.` } : { ok: false, text: r.error }); router.refresh(); }
  async function purge(e: React.FormEvent) { e.preventDefault(); setBusy("purge"); const r = await deleteAllActivityEvents({ confirmName: typed }); setBusy(""); if (r.ok) { setConfirm(false); setTyped(""); setFlash({ ok: true, text: `Deleted ${r.deleted.toLocaleString("en-US")} activity events. Discovered workflows and savings records were kept.` }); router.refresh(); } else setFlash({ ok: false, text: r.error }); }
  async function exportJson() {
    setBusy("export"); const r = await exportOrgData(); setBusy("");
    if (!r.ok) { setFlash({ ok: false, text: r.error }); return; }
    const blob = new Blob([r.json], { type: "application/json" }); const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = r.filename; a.click(); URL.revokeObjectURL(url);
    setFlash({ ok: true, text: `Exported ${r.filename}.` });
  }
  return (
    <div className="space-y-5" data-testid="data-page">
      {flash && <div className={cn("rounded-lg px-3 py-2 text-xs", flash.ok ? "bg-money-soft text-money" : "bg-danger-soft text-danger")} role="status" data-testid="data-flash">{flash.text}</div>}
      <Card data-testid="data-retention">
        <CardHeader title="Retention policy" subtitle="Raw activity events (app focus, step durations — never keystrokes or screenshots) are deleted after the retention window. Discovered workflows, opportunities and verified savings are derived data and are kept." action={<Badge tone="brand">{stats.retentionDays} days</Badge>} />
        <dl className="grid grid-cols-2 gap-y-1.5 text-xs sm:grid-cols-4">
          <dt className="text-ink-3">Activity events stored</dt><dd className="tabular font-medium" data-testid="data-events-total">{stats.total.toLocaleString("en-US")}</dd>
          <dt className="text-ink-3">Oldest / newest</dt><dd>{date(stats.oldest)} → {date(stats.newest)}</dd>
          <dt className="text-ink-3">Past retention</dt><dd className="tabular" data-testid="data-events-expired">{stats.expired.toLocaleString("en-US")} (before {date(stats.cutoff)})</dd>
          <dt className="text-ink-3">Active consents</dt><dd className="tabular">{stats.consents}</dd>
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={sweep} loading={busy === "sweep"} disabled={stats.expired === 0} data-testid="data-sweep"><Broom size={13} />Run retention sweep now</Button>
          <Button size="sm" variant="ghost" href="/app/settings" data-testid="data-change-retention">Change retention window</Button>
        </div>
      </Card>
      <Card data-testid="data-export">
        <CardHeader title="Export organization data" subtitle="A single JSON file with people, workflows, opportunities, agents, measurements, models, reports metadata, integrations and consents. Secrets, token hashes, password hashes and PDF bytes are excluded; raw activity events are summarized as a count." />
        <Button size="sm" onClick={exportJson} loading={busy === "export"} data-testid="data-export-btn"><Download size={13} />Export JSON</Button>
      </Card>
      <Card className="border-danger/40" data-testid="data-danger">
        <CardHeader title="Delete all activity events now" subtitle="Permanently removes every raw activity event for this organization and resets collector counters. Workflows already discovered stay, but they cannot be re-analyzed from scratch until new data is collected." />
        {isOwner ? <Button size="sm" variant="danger" onClick={() => setConfirm(true)} disabled={stats.total === 0} data-testid="data-purge"><Trash2 size={13} />Delete all activity events</Button> : <p className="text-xs text-ink-3">Only the organization owner can do this.</p>}
      </Card>
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Delete all activity events?">
        <form onSubmit={purge} className="space-y-3" data-testid="data-purge-modal">
          <p className="text-sm">This deletes <strong>{stats.total.toLocaleString("en-US")}</strong> events and cannot be undone. Type the organization name <strong>{stats.orgName}</strong> to confirm.</p>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={stats.orgName} autoFocus data-testid="data-purge-confirm-name" />
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button><Button type="submit" variant="danger" disabled={typed.trim() !== stats.orgName.trim()} loading={busy === "purge"} data-testid="data-purge-confirm">Delete permanently</Button></div>
        </form>
      </Modal>
    </div>
  );
}
