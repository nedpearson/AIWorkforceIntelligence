"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, KeyRound, Plus, Trash2 } from "lucide-react";
import { Badge, Button, Empty, Modal, PageHeader, Select, Table, Th, Td } from "@/components/ui";
import { cn } from "@/lib/utils";
import { CREDENTIAL_PRESETS } from "./presets";
import { deleteCredential } from "./actions";
import { InlineCredentialModal } from "../new/new-agent";
import { ago } from "../agents-list";

type Row = { id: string; name: string; provider: string; fields: string[]; lastUsedAt: string | null; createdAt: string; usedBy: string[] };
export function CredentialsClient({ rows, vaultReady }: { rows: Row[]; vaultReady: boolean }) {
  const router = useRouter();
  const [pick, setPick] = React.useState(false); const [provider, setProvider] = React.useState<string>("http_bearer"); const [creating, setCreating] = React.useState<string | null>(null);
  const [flash, setFlash] = React.useState<{ ok: boolean; text: string } | null>(null); const [busy, setBusy] = React.useState("");
  async function del(id: string) { if (!confirm("Delete this credential? Agents using it will fail until a replacement is attached.")) return; setBusy(id); const r = await deleteCredential({ id }); setBusy(""); setFlash(r.ok ? { ok: true, text: "Deleted" } : { ok: false, text: r.error }); router.refresh(); }
  return (
    <div>
      <PageHeader title="Credentials vault" subtitle="API tokens and passwords your agents use. Encrypted with AES-256-GCM; values are never shown again after saving and never written to logs." actions={<><Button variant="secondary" href="/app/agents"><ChevronLeft size={15} />All agents</Button><Button onClick={() => setPick(true)} disabled={!vaultReady} data-testid="cred-new"><Plus size={15} />Add credential</Button></>} />
      {!vaultReady && <div className="mb-3 rounded-lg bg-danger-soft p-3 text-xs text-danger" data-testid="vault-missing">VAULT_KEY is not set on the server, so credentials cannot be encrypted. Generate one with <code>openssl rand -base64 32</code> and set it in the environment.</div>}
      {flash && <div className={cn("mb-3 rounded-lg px-3 py-2 text-xs", flash.ok ? "bg-money-soft text-money" : "bg-danger-soft text-danger")} role="status">{flash.text}</div>}
      {rows.length === 0 ? <Empty title="No credentials yet" body="Add the API token or login your first agent needs. Each template lists exactly which fields it uses." action={<Button onClick={() => setPick(true)} disabled={!vaultReady} data-testid="cred-empty-new"><KeyRound size={15} />Add credential</Button>} /> : (
        <Table>
          <thead><tr><Th>Name</Th><Th>Provider</Th><Th>Fields</Th><Th>Used by</Th><Th>Last used</Th><Th>Added</Th><Th></Th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} data-testid={`cred-row-${r.id}`}>
              <Td className="font-medium">{r.name}</Td><Td><Badge tone="neutral">{CREDENTIAL_PRESETS[r.provider]?.label ?? r.provider}</Badge></Td>
              <Td className="text-xs text-ink-2">{r.fields.map((f) => <span key={f} className="mr-1 rounded bg-surface-2 px-1.5 py-0.5 font-mono">{f}</span>)}</Td>
              <Td className="text-xs">{r.usedBy.join(", ") || <span className="text-ink-3">—</span>}</Td><Td className="text-xs">{ago(r.lastUsedAt)}</Td><Td className="text-xs">{new Date(r.createdAt).toLocaleDateString()}</Td>
              <Td><Button size="sm" variant="ghost" onClick={() => del(r.id)} loading={busy === r.id} aria-label="Delete" data-testid={`cred-delete-${r.id}`}><Trash2 size={14} /></Button></Td>
            </tr>))}</tbody>
        </Table>)}
      <Modal open={pick} onClose={() => setPick(false)} title="Which kind of credential?">
        <Select label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)} data-testid="cred-provider">{Object.entries(CREDENTIAL_PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
        <p className="mt-2 text-xs text-ink-2">{CREDENTIAL_PRESETS[provider]?.help}</p>
        <div className="mt-3 flex justify-end"><Button onClick={() => { setPick(false); setCreating(provider); }} data-testid="cred-provider-next">Continue</Button></div>
      </Modal>
      <InlineCredentialModal provider={creating} onClose={() => setCreating(null)} onCreated={() => { setCreating(null); setFlash({ ok: true, text: "Saved (encrypted)" }); router.refresh(); }} />
    </div>
  );
}
