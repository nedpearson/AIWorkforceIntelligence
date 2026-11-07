"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Upload, FileText, ClipboardPaste, History, Layers, AlertTriangle, CheckCircle2, XCircle, Archive, FilePlus2, Search } from "lucide-react";
import { Button, Badge, Input, Select, Textarea, Modal, Empty, Table, Th, Td } from "@/components/ui";
import { StatusPill, Drawer } from "@/components/ui/enterprise";
import { cn, fmtNum } from "@/lib/utils";
import { pasteTextAction, getDocumentAction, decideAction } from "@/app/app/brain/actions";
import type { DocumentDetail } from "@/engine/brain/review";
import { CATEGORY_LABEL, fmtDate, type BrainData } from "./brain-center";

const CATS = ["company", "policy", "procedure", "pricing", "product", "customer", "vendor", "terminology", "goal", "decision", "preference", "system", "general"];
const ROLES = ["owner", "admin", "manager", "employee", "consultant", "viewer"];
type UploadResult = { name: string; status: string; title?: string; error?: string; documentId?: string; duplicateOf?: { id: string; title: string; similarity: number }; warnings?: string[] };

export function BrainLibrary({ data, deptName, initialDoc, pasteCategory, onPasteConsumed }: { data: BrainData; deptName: Map<string, string>; initialDoc: string | null; pasteCategory: string | null; onPasteConsumed: () => void }) {
  const router = useRouter();
  const [status, setStatus] = React.useState(""); const [cat, setCat] = React.useState(""); const [q, setQ] = React.useState("");
  const [openDoc, setOpenDoc] = React.useState<string | null>(initialDoc);
  const [paste, setPaste] = React.useState<{ category: string; supersedesId?: string; title?: string; content?: string; departmentId?: string | null } | null>(null);
  React.useEffect(() => { if (pasteCategory) { setPaste({ category: pasteCategory }); onPasteConsumed(); } }, [pasteCategory, onPasteConsumed]);
  const rows = data.docs.filter((d) => (!status ? d.status !== "archived" : d.status === status) && (!cat || d.category === cat) && (!q || d.title.toLowerCase().includes(q.toLowerCase())));
  return (
    <div data-testid="brain-library">
      {data.perms.ingest ? <UploadZone data={data} onDone={() => router.refresh()} onPaste={() => setPaste({ category: "general" })} /> :
        <p className="card mb-4 p-3 text-xs text-ink-2">Your role can read approved knowledge. Adding documents requires an owner, admin or consultant.</p>}
      <div className="card mb-3 flex flex-wrap items-center gap-2 p-2.5" data-testid="brain-lib-filters">
        <label className="relative"><span className="sr-only">Search documents</span><Search size={14} className="absolute left-2.5 top-2.5 text-ink-3" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles" className="h-8 w-44 rounded-lg border border-border bg-surface pl-8 pr-2 text-xs" data-testid="brain-lib-search" /></label>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 rounded-lg border border-border bg-surface px-2 text-xs" data-testid="brain-lib-status"><option value="">Active (not archived)</option><option value="approved">Approved</option><option value="pending_review">Pending review</option><option value="rejected">Rejected</option><option value="archived">Archived</option></select>
        <select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} className="h-8 rounded-lg border border-border bg-surface px-2 text-xs" data-testid="brain-lib-category"><option value="">All categories</option>{CATS.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select>
        <span className="ml-auto text-xs text-ink-3">{rows.length} of {data.docs.length}</span>
      </div>
      {rows.length === 0 ? <Empty title={data.docs.length ? "No documents match these filters" : "No documents yet"} body={data.docs.length ? "Clear the filters to see everything." : "Upload a policy, price sheet or procedure — or paste text — to start teaching your AI employees."} /> : (
        <Table>
          <thead><tr><Th>Document</Th><Th>Status</Th><Th>Category</Th><Th className="hidden md:table-cell">Department</Th><Th className="hidden lg:table-cell">Who can read</Th><Th className="hidden md:table-cell">Freshness</Th></tr></thead>
          <tbody>{rows.map((d) => (
            <tr key={d.id} className="cursor-pointer hover:bg-surface-2/60" onClick={() => setOpenDoc(d.id)}>
              <Td><button className="flex items-start gap-2 text-left" onClick={(e) => { e.stopPropagation(); setOpenDoc(d.id); }} data-testid={`brain-doc-${d.id}`}><FileText size={15} className="mt-0.5 shrink-0 text-purple-ink" /><span><span className="font-semibold">{d.title}</span><span className="block text-[11px] text-ink-3">v{d.version} · {fmtNum(d.wordCount)} words · added {fmtDate(d.createdAt)}</span></span></button></Td>
              <Td><StatusPill status={d.status} map={{ pending_review: "gold", approved: "emerald", archived: "midnight" }} /></Td>
              <Td className="text-xs">{CATEGORY_LABEL[d.category] ?? d.category}</Td>
              <Td className="hidden text-xs md:table-cell">{d.departmentId ? deptName.get(d.departmentId) ?? "—" : "Org-wide"}</Td>
              <Td className="hidden text-xs lg:table-cell">{d.allowedRoles.length ? d.allowedRoles.join(", ") : "All members"}</Td>
              <Td className="hidden text-xs md:table-cell">{d.status !== "approved" ? "—" : d.stale ? <span className="font-semibold text-gold-ink">Review due</span> : <span className="text-emerald-ink">Current</span>}</Td>
            </tr>))}</tbody>
        </Table>
      )}
      {openDoc && <DocDrawer id={openDoc} data={data} deptName={deptName} onClose={() => setOpenDoc(null)} onNewVersion={(d) => { setOpenDoc(null); setPaste({ category: d.category, supersedesId: d.id, title: d.title, content: d.content, departmentId: d.departmentId }); }} />}
      {paste && <PasteModal data={data} init={paste} onClose={() => setPaste(null)} onDone={() => { setPaste(null); router.refresh(); }} />}
    </div>
  );
}

function UploadZone({ data, onDone, onPaste }: { data: BrainData; onDone: () => void; onPaste: () => void }) {
  const [drag, setDrag] = React.useState(false); const [busy, setBusy] = React.useState(false);
  const [results, setResults] = React.useState<(UploadResult & { file?: File })[]>([]);
  const [category, setCategory] = React.useState(""); const [dept, setDept] = React.useState(""); const [roles, setRoles] = React.useState<string[]>([]);
  const input = React.useRef<HTMLInputElement>(null);
  async function send(files: File[], allowNear = false) {
    if (!files.length) return; setBusy(true);
    const fd = new FormData(); files.forEach((f) => fd.append("files", f)); if (category) fd.set("category", category); if (dept) fd.set("departmentId", dept); if (roles.length) fd.set("allowedRoles", roles.join(",")); if (allowNear) fd.set("allowNearDuplicate", "1");
    try {
      const res = await fetch("/api/brain/upload", { method: "POST", body: fd });
      const j = (await res.json().catch(() => ({}))) as { results?: UploadResult[]; error?: string };
      const rs = j.results ?? files.map((f) => ({ name: f.name, status: "error", error: j.error ?? `Upload failed (HTTP ${res.status})` }));
      setResults((prev) => [...rs.map((r) => ({ ...r, file: files.find((f) => f.name === r.name) })), ...prev.filter((p) => !rs.some((r) => r.name === p.name))]);
      if (rs.some((r) => r.status === "created")) onDone();
    } finally { setBusy(false); }
  }
  return (
    <div className="mb-4 grid gap-3 lg:grid-cols-[1.5fr_1fr]">
      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); send(Array.from(e.dataTransfer.files)); }}
        className={cn("card flex flex-col items-center justify-center gap-2 border-2 border-dashed p-6 text-center transition", drag ? "border-purple bg-purple-soft/40" : "border-border")} data-testid="brain-upload">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-purple-soft text-purple-ink"><Upload size={20} /></span>
        <div className="text-sm font-bold">Drop files to teach your AI</div>
        <p className="max-w-sm text-xs text-ink-2">Word (.docx), PDF, CSV, TXT, Markdown, HTML or JSON — up to 10 MB each. New documents wait for review before any AI can use them.</p>
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          <Button size="sm" loading={busy} onClick={() => input.current?.click()} data-testid="brain-upload-pick"><Upload size={14} />Choose files</Button>
          <Button size="sm" variant="secondary" onClick={onPaste} data-testid="brain-paste-open"><ClipboardPaste size={14} />Paste text</Button>
        </div>
        <input ref={input} type="file" multiple hidden accept=".txt,.md,.markdown,.csv,.html,.htm,.json,.docx,.pdf" onChange={(e) => { send(Array.from(e.target.files ?? [])); e.target.value = ""; }} data-testid="brain-upload-input" aria-label="Upload knowledge files" />
      </div>
      <div className="card space-y-2 p-4">
        <div className="text-xs font-bold uppercase tracking-wide text-ink-3">Apply to uploads</div>
        <Select label="Category" value={category} onChange={(e) => setCategory(e.target.value)} data-testid="brain-upload-category"><option value="">Detect from title</option>{CATS.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</Select>
        <Select label="Department" value={dept} onChange={(e) => setDept(e.target.value)} data-testid="brain-upload-dept"><option value="">Org-wide</option>{data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        <fieldset><legend className="mb-1 text-xs font-medium text-ink-2">Restrict to roles (none = all members)</legend><div className="flex flex-wrap gap-1.5">{ROLES.map((r) => <label key={r} className={cn("cursor-pointer rounded-lg border px-2 py-0.5 text-[11px] font-semibold capitalize", roles.includes(r) ? "border-royal bg-royal-soft text-royal-ink" : "border-border text-ink-2")}><input type="checkbox" className="sr-only" checked={roles.includes(r)} onChange={() => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r])} data-testid={`brain-upload-role-${r}`} />{r}</label>)}</div></fieldset>
      </div>
      {results.length > 0 && <ul className="card space-y-1.5 p-3 lg:col-span-2" data-testid="brain-upload-results" aria-live="polite">{results.map((r) => (
        <li key={r.name} className="flex flex-wrap items-center gap-2 text-xs">
          {r.status === "created" ? <CheckCircle2 size={14} className="text-emerald-ink" /> : r.status === "error" ? <XCircle size={14} className="text-coral-ink" /> : <AlertTriangle size={14} className="text-gold-ink" />}
          <span className="font-semibold">{r.name}</span>
          <span className="text-ink-2">{r.status === "created" ? "added — waiting for review" : r.status === "duplicate" ? `exact duplicate of "${r.duplicateOf?.title}" — not added` : r.status === "near_duplicate" ? `${Math.round((r.duplicateOf?.similarity ?? 0) * 100)}% similar to "${r.duplicateOf?.title}"` : r.error}</span>
          {r.warnings?.map((w) => <span key={w} className="text-gold-ink">{w}</span>)}
          {r.status === "near_duplicate" && r.file && <Button size="sm" variant="secondary" onClick={() => send([r.file!], true)} data-testid="brain-upload-anyway">Upload anyway</Button>}
        </li>))}</ul>}
    </div>
  );
}

function PasteModal({ data, init, onClose, onDone }: { data: BrainData; init: { category: string; supersedesId?: string; title?: string; content?: string; departmentId?: string | null }; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = React.useState(init.title ?? ""); const [content, setContent] = React.useState(init.content ?? ""); const [category, setCategory] = React.useState(init.category);
  const [dept, setDept] = React.useState(init.departmentId ?? ""); const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState<string | null>(null);
  const [near, setNear] = React.useState<{ title: string; similarity: number } | null>(null);
  async function submit(allowNear = false) {
    setBusy(true); setError(null);
    const r = await pasteTextAction({ title, content, category, departmentId: dept || null, allowedRoles: [], supersedesId: init.supersedesId ?? null, allowNearDuplicate: allowNear });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if (r.status === "duplicate") return setError(`This exact text is already in the Brain as "${r.duplicateOf?.title}".`);
    if (r.status === "near_duplicate" && r.duplicateOf) return setNear(r.duplicateOf);
    onDone();
  }
  return (
    <Modal open onClose={onClose} title={init.supersedesId ? `New version of "${init.title}"` : "Paste text"} wide>
      <div className="space-y-3" data-testid="brain-paste-form">
        {init.supersedesId && <p className="rounded-lg bg-purple-soft/50 p-2 text-xs text-purple-ink">The new version goes to review. When approved it replaces the current version, which is archived (kept in version history).</p>}
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="brain-paste-title" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Category" value={category} onChange={(e) => setCategory(e.target.value)} data-testid="brain-paste-category">{CATS.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</Select>
          <Select label="Department" value={dept} onChange={(e) => setDept(e.target.value)} data-testid="brain-paste-dept"><option value="">Org-wide</option>{data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        </div>
        <Textarea label="Content" rows={12} value={content} onChange={(e) => setContent(e.target.value)} data-testid="brain-paste-content" placeholder="# Heading&#10;Paste the policy or procedure text here…" />
        {near && <div className="flex flex-wrap items-center gap-2 rounded-lg bg-gold-soft p-2 text-xs text-gold-ink" data-testid="brain-paste-near"><AlertTriangle size={14} />{Math.round(near.similarity * 100)}% similar to &ldquo;{near.title}&rdquo;. <Button size="sm" variant="secondary" onClick={() => submit(true)} data-testid="brain-paste-anyway">Add anyway</Button></div>}
        {error && <p className="text-xs font-semibold text-coral-ink" role="alert">{error}</p>}
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={title.trim().length < 2 || content.trim().length < 20} onClick={() => submit()} data-testid="brain-paste-submit">{init.supersedesId ? "Submit new version" : "Add to review queue"}</Button></div>
      </div>
    </Modal>
  );
}

function DocDrawer({ id, data, deptName, onClose, onNewVersion }: { id: string; data: BrainData; deptName: Map<string, string>; onClose: () => void; onNewVersion: (d: DocumentDetail) => void }) {
  const router = useRouter();
  const [d, setD] = React.useState<DocumentDetail | null | undefined>(undefined); const [busy, setBusy] = React.useState<string | null>(null); const [error, setError] = React.useState<string | null>(null);
  const [showChunks, setShowChunks] = React.useState(false);
  React.useEffect(() => { let on = true; setD(undefined); getDocumentAction(id).then((x) => on && setD(x)); return () => { on = false; }; }, [id]);
  const row = data.docs.find((x) => x.id === id);
  async function decide(decision: "approve" | "reject" | "archive") { setBusy(decision); setError(null); const r = await decideAction({ items: [{ kind: "document", id }], decision }); setBusy(null); if (!r.ok) return setError(r.error); router.refresh(); onClose(); }
  return (
    <Drawer open onClose={onClose} title={d?.title ?? "Document"} testid="brain-doc-drawer" width="max-w-2xl">
      {d === undefined ? <div className="space-y-2"><div className="skeleton h-4 w-2/3" /><div className="skeleton h-24 w-full" /></div> : d === null ? <p className="text-sm text-ink-2">This document is not available to your role.</p> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <StatusPill status={d.status} map={{ pending_review: "gold" }} /><Badge tone="purple">v{d.version}</Badge><Badge>{CATEGORY_LABEL[d.category] ?? d.category}</Badge>
            <span className="text-ink-2">{d.departmentId ? deptName.get(d.departmentId) : "Org-wide"} · {d.allowedRoles.length ? `Roles: ${d.allowedRoles.join(", ")}` : "All members"} · {fmtNum(d.wordCount)} words</span>
          </div>
          <div className="text-xs text-ink-2">Added {fmtDate(d.createdAt)}{d.approvedAt ? ` · approved ${fmtDate(d.approvedAt)} · re-review every ${d.reviewEveryDays} days` : ""}</div>
          {d.similar.length > 0 && <div className="rounded-xl border border-gold/40 bg-gold-soft/40 p-3 text-xs" data-testid="brain-doc-similar"><div className="mb-1 flex items-center gap-1.5 font-bold text-gold-ink"><Layers size={13} />Possible duplicates</div><ul className="space-y-0.5">{d.similar.map((s) => <li key={s.id}>{s.title} — {Math.round(s.similarity * 100)}% similar ({s.status.replace("_", " ")})</li>)}</ul></div>}
          <div className="flex flex-wrap gap-2">
            {row?.canApprove && d.status === "pending_review" && <><Button size="sm" loading={busy === "approve"} onClick={() => decide("approve")} data-testid="brain-doc-approve"><CheckCircle2 size={14} />Approve</Button><Button size="sm" variant="secondary" loading={busy === "reject"} onClick={() => decide("reject")} data-testid="brain-doc-reject"><XCircle size={14} />Reject</Button></>}
            {row?.canApprove && d.status === "approved" && <Button size="sm" variant="secondary" loading={busy === "archive"} onClick={() => decide("archive")} data-testid="brain-doc-archive"><Archive size={14} />Archive</Button>}
            {data.perms.ingest && ["approved", "pending_review"].includes(d.status) && <Button size="sm" variant="secondary" onClick={() => onNewVersion(d)} data-testid="brain-doc-new-version"><FilePlus2 size={14} />New version</Button>}
          </div>
          {error && <p className="text-xs font-semibold text-coral-ink" role="alert">{error}</p>}
          <section><h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-3">Content preview</h3><pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-surface-2 p-3 text-xs leading-relaxed" data-testid="brain-doc-content">{d.content.slice(0, 8000)}{d.content.length > 8000 ? "\n…" : ""}</pre></section>
          <section>
            <button className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-3" onClick={() => setShowChunks(!showChunks)} aria-expanded={showChunks} data-testid="brain-doc-chunks-toggle"><Layers size={13} />Retrieval chunks ({d.chunks.length})</button>
            {showChunks && <ol className="space-y-1.5">{d.chunks.map((c) => <li key={c.ordinal} className="rounded-lg border border-border p-2 text-xs"><span className="font-semibold text-purple-ink">#{c.ordinal + 1}{c.heading ? ` · ${c.heading}` : ""}</span><p className="mt-0.5 line-clamp-3 text-ink-2">{c.text}</p></li>)}</ol>}
          </section>
          <section data-testid="brain-doc-versions"><h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-3"><History size={13} />Version history</h3>
            <ol className="space-y-1">{d.versions.map((v) => <li key={v.id} className={cn("flex items-center justify-between rounded-lg px-2 py-1.5 text-xs", v.id === d.id ? "bg-purple-soft/50" : "")}><span>v{v.version} · {v.title}</span><span className="flex items-center gap-2 text-ink-2"><StatusPill status={v.status} map={{ pending_review: "gold" }} />{fmtDate(v.approvedAt ?? v.createdAt)}</span></li>)}</ol>
          </section>
        </div>
      )}
    </Drawer>
  );
}
