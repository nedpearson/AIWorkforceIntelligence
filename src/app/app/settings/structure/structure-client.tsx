"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Building2, MapPin, Network, Plus, Pencil, Trash2, ChevronRight, Users, Layers } from "lucide-react";
import { Button, Card, Empty, Input, Modal, Select, Table, Th, Td, Tooltip, BasisChip, Badge } from "@/components/ui";
import { SectionHeader } from "@/components/ui/enterprise";
import { fmtUSD, cn } from "@/lib/utils";
import { saveBusinessUnit, deleteBusinessUnit, saveLocation, deleteLocation, updateDepartmentStructure, bulkAssignEmployees } from "./actions";

type Basis = "observed" | "estimated" | "assumed";
type BU = { id: string; name: string; kind: "subsidiary" | "division" | "business_unit"; parentBusinessUnitId: string | null; country: string | null; currency: string };
type Loc = { id: string; name: string; businessUnitId: string | null; city: string | null; region: string | null; country: string; timezone: string };
type Dept = { id: string; name: string; businessUnitId: string | null; locationId: string | null; annualOverhead: number | null; overheadBasis: Basis; headcount: number; laborAnnual: number; employeesOffBu: number; employeesOffLoc: number };
export type StructureData = { orgName: string; orgCurrency: string; orgTimezone: string; businessUnits: BU[]; locations: Loc[]; departments: Dept[]; unassignedEmployees: number; laborTotal: number };

const KIND_LABEL: Record<BU["kind"], string> = { subsidiary: "Subsidiary", division: "Division", business_unit: "Business unit" };
type Flash = { kind: "ok" | "error"; text: string } | null;

function useAction() {
  const router = useRouter(); const [busy, setBusy] = React.useState(false); const [flash, setFlash] = React.useState<Flash>(null);
  const run = async <T extends { ok: boolean; error?: string }>(fn: () => Promise<T>, okText: string | ((r: T) => string)) => {
    setBusy(true); setFlash(null);
    try { const r = await fn(); if (r.ok) { setFlash({ kind: "ok", text: typeof okText === "string" ? okText : okText(r) }); router.refresh(); } else setFlash({ kind: "error", text: r.error ?? "Something went wrong" }); return r.ok; }
    catch (e) { setFlash({ kind: "error", text: e instanceof Error ? e.message : String(e) }); return false; }
    finally { setBusy(false); }
  };
  return { busy, flash, setFlash, run };
}
function FlashBar({ flash }: { flash: Flash }) {
  if (!flash) return null;
  return <div role={flash.kind === "error" ? "alert" : "status"} className={cn("mb-3 rounded-xl px-3 py-2 text-sm", flash.kind === "ok" ? "bg-emerald-soft text-emerald-ink" : "bg-coral-soft text-coral-ink")} data-testid="structure-flash">{flash.text}</div>;
}

// ------------------------------------------------------------------ org tree
type TreeNode = { key: string; label: string; kind: "org" | "bu" | "loc" | "dept" | "none"; headcount: number; labor: number; children: TreeNode[] };
function buildTree(d: StructureData): TreeNode {
  const deptNode = (x: Dept): TreeNode => ({ key: `d-${x.id}`, label: x.name, kind: "dept", headcount: x.headcount, labor: x.laborAnnual, children: [] });
  const roll = (n: TreeNode): TreeNode => { const ch = n.children.map(roll); return n.kind === "dept" ? n : { ...n, children: ch, headcount: ch.reduce((s, c) => s + c.headcount, 0), labor: ch.reduce((s, c) => s + c.labor, 0) }; };
  const locNode = (l: Loc): TreeNode => ({ key: `l-${l.id}`, label: `${l.name}${l.city ? ` · ${l.city}` : ""}`, kind: "loc", headcount: 0, labor: 0, children: d.departments.filter((x) => x.locationId === l.id).map(deptNode) });
  const buNode = (b: BU): TreeNode => ({ key: `b-${b.id}`, label: `${b.name}`, kind: "bu", headcount: 0, labor: 0, children: [
    ...d.businessUnits.filter((c) => c.parentBusinessUnitId === b.id).map(buNode),
    ...d.locations.filter((l) => l.businessUnitId === b.id).map(locNode),
    ...d.departments.filter((x) => x.businessUnitId === b.id && !(x.locationId && d.locations.some((l) => l.id === x.locationId))).map(deptNode),
  ] });
  const topBus = d.businessUnits.filter((b) => !b.parentBusinessUnitId || !d.businessUnits.some((p) => p.id === b.parentBusinessUnitId));
  const looseLocs = d.locations.filter((l) => !l.businessUnitId);
  const placed = new Set<string>();
  const walk = (n: TreeNode) => { if (n.kind === "dept") placed.add(n.key); n.children.forEach(walk); };
  const root: TreeNode = { key: "org", label: d.orgName, kind: "org", headcount: 0, labor: 0, children: [...topBus.map(buNode), ...looseLocs.map(locNode)] };
  walk(root);
  const rest = d.departments.filter((x) => !placed.has(`d-${x.id}`));
  if (rest.length) root.children.push({ key: "none", label: "Not assigned to a business unit or location", kind: "none", headcount: 0, labor: 0, children: rest.map(deptNode) });
  return roll(root);
}
const ICON = { org: Network, bu: Building2, loc: MapPin, dept: Layers, none: Layers };
const TINT = { org: "bg-midnight text-white", bu: "bg-royal-soft text-royal-ink", loc: "bg-cyan-soft text-cyan-ink", dept: "bg-indigo-soft text-indigo-ink", none: "bg-surface-2 text-ink-2" };
function TreeItem({ n, depth }: { n: TreeNode; depth: number }) {
  const [open, setOpen] = React.useState(depth < 3);
  const has = n.children.length > 0; const I = ICON[n.kind];
  return (
    <li role="treeitem" aria-expanded={has ? open : undefined} aria-level={depth + 1} aria-selected={false}>
      <div className={cn("flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-surface-2", n.kind === "none" && "opacity-80")} style={{ paddingLeft: 8 + depth * 18 }}>
        <button type="button" onClick={() => setOpen(!open)} disabled={!has} aria-label={has ? (open ? `Collapse ${n.label}` : `Expand ${n.label}`) : undefined} className={cn("flex h-6 w-6 items-center justify-center rounded-md text-ink-3", !has && "invisible")} data-testid={`tree-toggle-${n.key}`}><ChevronRight size={14} className={cn("transition", open && "rotate-90")} /></button>
        <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", TINT[n.kind])}><I size={14} /></span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{n.label}</span>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-ink-2"><Users size={12} />{n.headcount}</span>
        <span className="w-24 shrink-0 text-right text-xs font-semibold tabular text-ink sm:w-28">{fmtUSD(n.labor)}</span>
      </div>
      {has && open && <ul role="group">{n.children.map((c) => <TreeItem key={c.key} n={c} depth={depth + 1} />)}</ul>}
    </li>
  );
}

// ------------------------------------------------------------------ main
export function StructureClient({ data }: { data: StructureData }) {
  const { busy, flash, run } = useAction();
  const [buEdit, setBuEdit] = React.useState<Partial<BU> | null>(null);
  const [locEdit, setLocEdit] = React.useState<Partial<Loc> | null>(null);
  const [rows, setRows] = React.useState(() => Object.fromEntries(data.departments.map((d) => [d.id, { businessUnitId: d.businessUnitId ?? "", locationId: d.locationId ?? "", annualOverhead: d.annualOverhead == null ? "" : String(d.annualOverhead), overheadBasis: d.overheadBasis }])));
  React.useEffect(() => { setRows(Object.fromEntries(data.departments.map((d) => [d.id, { businessUnitId: d.businessUnitId ?? "", locationId: d.locationId ?? "", annualOverhead: d.annualOverhead == null ? "" : String(d.annualOverhead), overheadBasis: d.overheadBasis }]))); }, [data.departments]);
  const [bulk, setBulk] = React.useState({ departmentId: data.departments[0]?.id ?? "", setBusinessUnit: true, businessUnitId: data.departments[0]?.businessUnitId ?? "", setLocation: true, locationId: data.departments[0]?.locationId ?? "" });
  const tree = React.useMemo(() => buildTree(data), [data]);
  const buName = new Map(data.businessUnits.map((b) => [b.id, b.name]));
  const bulkDept = data.departments.find((d) => d.id === bulk.departmentId);
  const dirty = (d: Dept) => { const r = rows[d.id]; return !!r && (r.businessUnitId !== (d.businessUnitId ?? "") || r.locationId !== (d.locationId ?? "") || r.annualOverhead !== (d.annualOverhead == null ? "" : String(d.annualOverhead)) || r.overheadBasis !== d.overheadBasis); };

  return (
    <div data-testid="structure-page">
      <div className="mb-2 flex flex-col gap-1">
        <h2 className="text-lg font-bold tracking-tight">Locations & business units</h2>
        <p className="max-w-3xl text-sm text-ink-2">Model how the organization is structured. Business Intelligence and Process Mining filter by these, and department overhead feeds the &quot;entered operating expense&quot; figure. Every change is audited.</p>
      </div>
      <FlashBar flash={flash} />

      <SectionHeader accent="midnight" icon={<Network size={16} />} title="Organization tree" subtitle={`Org → business units → locations → departments, with headcount and loaded labor (finance engine; ${fmtUSD(data.laborTotal)} analyzed in total).`} />
      <Card className="p-2 sm:p-3" data-testid="org-tree">
        <div className="mb-1 hidden items-center justify-end gap-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3 sm:flex"><span>People</span><span className="w-28 text-right">Labor / yr</span></div>
        <ul role="tree" aria-label="Organization structure"><TreeItem n={tree} depth={0} /></ul>
        {data.unassignedEmployees > 0 && <p className="px-2 pt-2 text-xs text-ink-3">{data.unassignedEmployees} active employee{data.unassignedEmployees === 1 ? " has" : "s have"} no department and {data.unassignedEmployees === 1 ? "is" : "are"} not shown.</p>}
      </Card>

      <div className="mt-2 grid grid-cols-1 gap-x-4 2xl:grid-cols-2">
        <div className="min-w-0">
          <SectionHeader accent="royal" icon={<Building2 size={16} />} title="Business units" subtitle="Subsidiaries, divisions and business units" action={<Button size="sm" onClick={() => setBuEdit({ kind: "business_unit", currency: data.orgCurrency })} data-testid="bu-add"><Plus size={14} />Add business unit</Button>} />
          {data.businessUnits.length === 0 ? <Empty title="No business units yet" body="Add one to group locations and departments (e.g. a division or subsidiary)." action={<Button size="sm" onClick={() => setBuEdit({ kind: "business_unit", currency: data.orgCurrency })} data-testid="bu-add-empty">Add business unit</Button>} /> : (
            <Table>
              <thead><tr><Th>Name</Th><Th>Kind</Th><Th>Parent</Th><Th>Country · currency</Th><Th className="text-right">Actions</Th></tr></thead>
              <tbody>{data.businessUnits.map((b) => (
                <tr key={b.id} data-testid={`bu-row-${b.id}`}>
                  <Td className="font-medium">{b.name}</Td><Td><Badge tone="royal">{KIND_LABEL[b.kind]}</Badge></Td><Td className="text-ink-2">{b.parentBusinessUnitId ? buName.get(b.parentBusinessUnitId) ?? "—" : "—"}</Td><Td className="text-ink-2">{b.country ?? "—"} · {b.currency}</Td>
                  <Td className="text-right whitespace-nowrap">
                    <button type="button" className="rounded-lg p-2 text-ink-2 hover:bg-surface-2" aria-label={`Edit ${b.name}`} onClick={() => setBuEdit(b)} data-testid={`bu-edit-${b.id}`}><Pencil size={14} /></button>
                    <button type="button" className="rounded-lg p-2 text-coral-ink hover:bg-coral-soft" aria-label={`Delete ${b.name}`} disabled={busy} onClick={() => { if (confirm(`Delete ${b.name}? Departments, locations and employees keep existing but are unassigned from it.`)) void run(() => deleteBusinessUnit({ id: b.id }), `Deleted ${b.name}`); }} data-testid={`bu-delete-${b.id}`}><Trash2 size={14} /></button>
                  </Td>
                </tr>))}</tbody>
            </Table>
          )}
        </div>
        <div className="min-w-0">
          <SectionHeader accent="cyan" icon={<MapPin size={16} />} title="Locations" subtitle="Sites, offices and branches" action={<Button size="sm" onClick={() => setLocEdit({ country: "US", timezone: data.orgTimezone })} data-testid="loc-add"><Plus size={14} />Add location</Button>} />
          {data.locations.length === 0 ? <Empty title="No locations yet" body="Add the sites your teams work from to filter analytics by location." action={<Button size="sm" onClick={() => setLocEdit({ country: "US", timezone: data.orgTimezone })} data-testid="loc-add-empty">Add location</Button>} /> : (
            <Table>
              <thead><tr><Th>Name</Th><Th>Business unit</Th><Th>City · region</Th><Th>Country · time zone</Th><Th className="text-right">Actions</Th></tr></thead>
              <tbody>{data.locations.map((l) => (
                <tr key={l.id} data-testid={`loc-row-${l.id}`}>
                  <Td className="font-medium">{l.name}</Td><Td className="text-ink-2">{l.businessUnitId ? buName.get(l.businessUnitId) ?? "—" : "—"}</Td><Td className="text-ink-2">{[l.city, l.region].filter(Boolean).join(", ") || "—"}</Td><Td className="text-ink-2">{l.country} · {l.timezone}</Td>
                  <Td className="text-right whitespace-nowrap">
                    <button type="button" className="rounded-lg p-2 text-ink-2 hover:bg-surface-2" aria-label={`Edit ${l.name}`} onClick={() => setLocEdit(l)} data-testid={`loc-edit-${l.id}`}><Pencil size={14} /></button>
                    <button type="button" className="rounded-lg p-2 text-coral-ink hover:bg-coral-soft" aria-label={`Delete ${l.name}`} disabled={busy} onClick={() => { if (confirm(`Delete ${l.name}? Departments and employees are unassigned from it.`)) void run(() => deleteLocation({ id: l.id }), `Deleted ${l.name}`); }} data-testid={`loc-delete-${l.id}`}><Trash2 size={14} /></button>
                  </Td>
                </tr>))}</tbody>
            </Table>
          )}
        </div>
      </div>

      <SectionHeader accent="indigo" icon={<Layers size={16} />} title="Departments" subtitle="Assign each department to a business unit and location, and enter its annual non-labor overhead (software, facilities…)." />
      {data.departments.length === 0 ? <Empty title="No departments yet" body="Departments are created when employees are imported." action={<Button size="sm" href="/app/employees">Open Workforce</Button>} /> : (
        <Table>
          <thead><tr><Th>Department</Th><Th className="text-right">People</Th><Th>Business unit</Th><Th>Location</Th><Th><span className="inline-flex items-center gap-1">Overhead / yr<Tooltip text="Annual non-labor cost of this department you enter here (e.g. software licenses, rent share). It is added to labor to form 'entered operating expense'." /></span></Th><Th>Basis</Th><Th className="text-right">Save</Th></tr></thead>
          <tbody>{data.departments.map((d) => { const r = rows[d.id]; if (!r) return null; const set = (p: Partial<typeof r>) => setRows({ ...rows, [d.id]: { ...r, ...p } }); return (
            <tr key={d.id} data-testid={`dept-row-${d.id}`}>
              <Td className="font-medium">{d.name}<div className="text-[11px] font-normal text-ink-3">{fmtUSD(d.laborAnnual)} labor</div></Td>
              <Td className="text-right tabular">{d.headcount}</Td>
              <Td><select aria-label={`${d.name} business unit`} className="h-8 w-40 rounded-lg border border-border bg-surface px-2 text-xs" value={r.businessUnitId} onChange={(e) => set({ businessUnitId: e.target.value })} data-testid={`dept-bu-${d.id}`}><option value="">— None —</option>{data.businessUnits.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Td>
              <Td><select aria-label={`${d.name} location`} className="h-8 w-44 rounded-lg border border-border bg-surface px-2 text-xs" value={r.locationId} onChange={(e) => set({ locationId: e.target.value })} data-testid={`dept-loc-${d.id}`}><option value="">— None —</option>{data.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Td>
              <Td><input aria-label={`${d.name} annual overhead`} inputMode="decimal" placeholder="0" className="h-8 w-28 rounded-lg border border-border bg-surface px-2 text-right text-xs tabular" value={r.annualOverhead} onChange={(e) => set({ annualOverhead: e.target.value })} data-testid={`dept-overhead-${d.id}`} /></Td>
              <Td><div className="flex items-center gap-2"><select aria-label={`${d.name} overhead basis`} className="h-8 rounded-lg border border-border bg-surface px-2 text-xs" value={r.overheadBasis} onChange={(e) => set({ overheadBasis: e.target.value as Basis })} data-testid={`dept-basis-${d.id}`}><option value="observed">Observed (from invoices / GL)</option><option value="estimated">Estimated</option><option value="assumed">Assumed</option></select><span className="hidden 2xl:inline"><BasisChip basis={r.overheadBasis} /></span></div></Td>
              <Td className="text-right"><Button size="sm" variant={dirty(d) ? "primary" : "secondary"} disabled={busy || !dirty(d)} data-testid={`dept-save-${d.id}`}
                onClick={() => void run(() => updateDepartmentStructure({ id: d.id, businessUnitId: r.businessUnitId || null, locationId: r.locationId || null, annualOverhead: r.annualOverhead.trim() === "" ? null : r.annualOverhead, overheadBasis: r.overheadBasis }), `Saved ${d.name}`)}>Save</Button></Td>
            </tr>); })}</tbody>
        </Table>
      )}

      {data.departments.length > 0 && (
        <>
          <SectionHeader accent="purple" icon={<Users size={16} />} title="Bulk-assign employees" subtitle="Set the business unit and/or location of every employee in a department at once." />
          <Card data-testid="bulk-assign">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Select label="Department" value={bulk.departmentId} onChange={(e) => { const d = data.departments.find((x) => x.id === e.target.value); setBulk({ ...bulk, departmentId: e.target.value, businessUnitId: d?.businessUnitId ?? "", locationId: d?.locationId ?? "" }); }} data-testid="bulk-dept">
                {data.departments.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.headcount})</option>)}
              </Select>
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-2"><input type="checkbox" checked={bulk.setBusinessUnit} onChange={(e) => setBulk({ ...bulk, setBusinessUnit: e.target.checked })} data-testid="bulk-set-bu" />Set business unit</label>
                <select aria-label="Business unit to assign" disabled={!bulk.setBusinessUnit} className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm disabled:opacity-50" value={bulk.businessUnitId} onChange={(e) => setBulk({ ...bulk, businessUnitId: e.target.value })} data-testid="bulk-bu"><option value="">— None (clear) —</option>{data.businessUnits.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
              </div>
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-2"><input type="checkbox" checked={bulk.setLocation} onChange={(e) => setBulk({ ...bulk, setLocation: e.target.checked })} data-testid="bulk-set-loc" />Set location</label>
                <select aria-label="Location to assign" disabled={!bulk.setLocation} className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm disabled:opacity-50" value={bulk.locationId} onChange={(e) => setBulk({ ...bulk, locationId: e.target.value })} data-testid="bulk-loc"><option value="">— None (clear) —</option>{data.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
              </div>
              <div className="flex items-end">
                <Button className="w-full" disabled={busy || !bulk.departmentId || (!bulk.setBusinessUnit && !bulk.setLocation)} data-testid="bulk-apply"
                  onClick={() => void run(() => bulkAssignEmployees({ departmentId: bulk.departmentId, businessUnitId: bulk.businessUnitId || null, locationId: bulk.locationId || null, setBusinessUnit: bulk.setBusinessUnit, setLocation: bulk.setLocation }), (r) => `Updated ${(r as { updated?: number }).updated ?? 0} employee(s) in ${bulkDept?.name ?? "the department"}`)}>
                  Apply to {bulkDept?.headcount ?? 0} employee{bulkDept?.headcount === 1 ? "" : "s"}
                </Button>
              </div>
            </div>
            {bulkDept && (bulkDept.employeesOffBu > 0 || bulkDept.employeesOffLoc > 0) && <p className="mt-3 text-xs text-gold-ink">{bulkDept.employeesOffBu > 0 && `${bulkDept.employeesOffBu} employee(s) differ from the department's business unit. `}{bulkDept.employeesOffLoc > 0 && `${bulkDept.employeesOffLoc} employee(s) differ from the department's location.`}</p>}
          </Card>
        </>
      )}

      <BuModal value={buEdit} onClose={() => setBuEdit(null)} all={data.businessUnits} busy={busy} onSave={async (v) => { if (await run(() => saveBusinessUnit(v), v.id ? "Business unit saved" : "Business unit created")) setBuEdit(null); }} />
      <LocModal value={locEdit} onClose={() => setLocEdit(null)} bus={data.businessUnits} busy={busy} onSave={async (v) => { if (await run(() => saveLocation(v), v.id ? "Location saved" : "Location created")) setLocEdit(null); }} />
    </div>
  );
}

function BuModal({ value, onClose, onSave, all, busy }: { value: Partial<BU> | null; onClose: () => void; onSave: (v: Partial<BU>) => void; all: BU[]; busy: boolean }) {
  const [v, setV] = React.useState<Partial<BU>>({});
  React.useEffect(() => { if (value) setV(value); }, [value]);
  return (
    <Modal open={!!value} onClose={onClose} title={value?.id ? "Edit business unit" : "Add business unit"}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSave({ id: v.id, name: v.name ?? "", kind: v.kind ?? "business_unit", parentBusinessUnitId: v.parentBusinessUnitId ?? null, country: v.country ?? "", currency: v.currency ?? "USD" }); }} data-testid="bu-form">
        <Input label="Name" required maxLength={120} value={v.name ?? ""} onChange={(e) => setV({ ...v, name: e.target.value })} data-testid="bu-name" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select label="Kind" value={v.kind ?? "business_unit"} onChange={(e) => setV({ ...v, kind: e.target.value as BU["kind"] })} data-testid="bu-kind">{(Object.keys(KIND_LABEL) as BU["kind"][]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</Select>
          <Select label="Parent" value={v.parentBusinessUnitId ?? ""} onChange={(e) => setV({ ...v, parentBusinessUnitId: e.target.value || null })} data-testid="bu-parent"><option value="">— None (top level) —</option>{all.filter((b) => b.id !== v.id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
          <Input label="Country (ISO-2)" maxLength={2} placeholder="US" value={v.country ?? ""} onChange={(e) => setV({ ...v, country: e.target.value })} data-testid="bu-country" />
          <Input label="Currency (ISO-4217)" maxLength={3} required value={v.currency ?? ""} onChange={(e) => setV({ ...v, currency: e.target.value })} data-testid="bu-currency" />
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} data-testid="bu-save">Save</Button></div>
      </form>
    </Modal>
  );
}
function LocModal({ value, onClose, onSave, bus, busy }: { value: Partial<Loc> | null; onClose: () => void; onSave: (v: Partial<Loc>) => void; bus: BU[]; busy: boolean }) {
  const [v, setV] = React.useState<Partial<Loc>>({});
  React.useEffect(() => { if (value) setV(value); }, [value]);
  return (
    <Modal open={!!value} onClose={onClose} title={value?.id ? "Edit location" : "Add location"}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSave({ id: v.id, name: v.name ?? "", businessUnitId: v.businessUnitId ?? null, city: v.city ?? "", region: v.region ?? "", country: v.country ?? "US", timezone: v.timezone ?? "America/Chicago" }); }} data-testid="loc-form">
        <Input label="Name" required maxLength={120} value={v.name ?? ""} onChange={(e) => setV({ ...v, name: e.target.value })} data-testid="loc-name" />
        <Select label="Business unit" value={v.businessUnitId ?? ""} onChange={(e) => setV({ ...v, businessUnitId: e.target.value || null })} data-testid="loc-bu"><option value="">— None —</option>{bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="City" maxLength={120} value={v.city ?? ""} onChange={(e) => setV({ ...v, city: e.target.value })} data-testid="loc-city" />
          <Input label="Region / state" maxLength={120} value={v.region ?? ""} onChange={(e) => setV({ ...v, region: e.target.value })} data-testid="loc-region" />
          <Input label="Country (ISO-2)" required maxLength={2} value={v.country ?? ""} onChange={(e) => setV({ ...v, country: e.target.value })} data-testid="loc-country" />
          <Input label="Time zone (IANA)" required placeholder="America/Chicago" value={v.timezone ?? ""} onChange={(e) => setV({ ...v, timezone: e.target.value })} data-testid="loc-timezone" />
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} data-testid="loc-save">Save</Button></div>
      </form>
    </Modal>
  );
}
