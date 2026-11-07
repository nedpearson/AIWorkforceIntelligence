"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Copy, Trash2, UserPlus, Check } from "lucide-react";
import { Badge, Button, Card, CardHeader, Empty, Input, Modal, Select, Table, Th, Td } from "@/components/ui";
import { cn } from "@/lib/utils";
import { changeMemberRole, inviteMember, removeMember, revokeInvitation } from "../actions";
import { useTimeZone } from "@/components/time-zone";
import { formatDateTime } from "@/lib/datetime";

type Member = { id: string; userId: string; role: string; email: string; name: string; lastLoginAt: string | null; mfaEnabled: boolean; employeeId: string | null; employeeName: string | null; createdAt: string };
type Invitation = { id: string; email: string; role: string; employeeName: string | null; expiresAt: string; acceptedAt: string | null; createdAt: string };
const ROLES = ["owner", "admin", "manager", "employee", "consultant", "viewer"];
const ROLE_HELP: Record<string, string> = { owner: "Everything, including billing and deleting data", admin: "Manage people, agents, settings; no billing", manager: "See workflows, opportunities, finance; approve agent actions; no pay data", employee: "Own data only", consultant: "BridgeBox consultant acting inside this org", viewer: "Read-only dashboards" };
const date = (s: string | null, tz: string) => (s ? formatDateTime(s, tz, { dateStyle: "medium", timeStyle: "short" }) : "never");

export function MembersClient({ me, myRole, members, invitations, employees }: { me: string; myRole: string; members: Member[]; invitations: Invitation[]; employees: { id: string; name: string; title: string }[] }) {
  const tz = useTimeZone();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState(""); const [role, setRole] = React.useState("manager"); const [employeeId, setEmployeeId] = React.useState("");
  const [link, setLink] = React.useState<{ link: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = React.useState(""); const [copied, setCopied] = React.useState(false);
  const [flash, setFlash] = React.useState<{ ok: boolean; text: string } | null>(null);
  const isOwner = myRole === "owner";
  async function invite(e: React.FormEvent) {
    e.preventDefault(); setBusy("invite");
    const r = await inviteMember({ email, role, employeeId }); setBusy("");
    if (r.ok) { setOpen(false); setLink({ link: r.link, expiresAt: r.expiresAt }); setEmail(""); setEmployeeId(""); router.refresh(); } else setFlash({ ok: false, text: r.error });
  }
  async function setRoleFor(id: string, newRole: string) { setBusy(id); const r = await changeMemberRole({ membershipId: id, role: newRole }); setBusy(""); setFlash(r.ok ? { ok: true, text: "Role updated." } : { ok: false, text: r.error }); router.refresh(); }
  async function remove(m: Member) { if (!confirm(`Remove ${m.email} from this organization?`)) return; setBusy(m.id); const r = await removeMember({ membershipId: m.id }); setBusy(""); setFlash(r.ok ? { ok: true, text: "Member removed." } : { ok: false, text: r.error }); router.refresh(); }
  async function revoke(id: string) { setBusy(id); const r = await revokeInvitation({ id }); setBusy(""); setFlash(r.ok ? { ok: true, text: "Invitation revoked." } : { ok: false, text: r.error }); router.refresh(); }
  async function copy() { try { await navigator.clipboard.writeText(link!.link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } }
  const pending = invitations.filter((i) => !i.acceptedAt);
  return (
    <div className="space-y-5" data-testid="members-page">
      {flash && <div className={cn("rounded-lg px-3 py-2 text-xs", flash.ok ? "bg-money-soft text-money" : "bg-danger-soft text-danger")} role="status" data-testid="members-flash">{flash.text}</div>}
      <Card className="p-0">
        <div className="p-5 pb-0"><CardHeader title="Members" subtitle={`${members.length} people have access to this organization.`} action={<Button size="sm" onClick={() => setOpen(true)} data-testid="members-invite"><UserPlus size={14} />Invite</Button>} /></div>
        <Table className="rounded-t-none border-0 shadow-none">
          <thead><tr><Th>Person</Th><Th>Role</Th><Th>Linked employee</Th><Th>MFA</Th><Th>Last sign-in</Th><Th></Th></tr></thead>
          <tbody>{members.map((m) => (
            <tr key={m.id} data-testid={`members-row-${m.id}`}>
              <Td><div className="text-xs font-medium">{m.name || m.email}{m.userId === me && <Badge tone="brand" className="ml-2">you</Badge>}</div><div className="text-[11px] text-ink-3">{m.email}</div></Td>
              <Td><select value={m.role} disabled={busy === m.id || m.userId === me || (m.role === "owner" && !isOwner)} onChange={(e) => setRoleFor(m.id, e.target.value)} className="h-8 rounded-md border border-border bg-surface px-2 text-xs capitalize" data-testid={`members-role-${m.id}`} aria-label="Role">{ROLES.filter((r) => isOwner || r !== "owner").map((r) => <option key={r} value={r}>{r}</option>)}</select></Td>
              <Td className="text-xs">{m.employeeName ?? <span className="text-ink-3">—</span>}</Td>
              <Td>{m.mfaEnabled ? <Badge tone="verified">on</Badge> : <Badge tone="neutral">off</Badge>}</Td>
              <Td className="text-xs whitespace-nowrap">{date(m.lastLoginAt, tz)}</Td>
              <Td>{m.userId !== me && <Button size="sm" variant="ghost" onClick={() => remove(m)} loading={busy === m.id} aria-label="Remove member" data-testid={`members-remove-${m.id}`}><Trash2 size={14} /></Button>}</Td>
            </tr>))}</tbody>
        </Table>
      </Card>
      <Card className="p-0">
        <div className="p-5 pb-0"><CardHeader title="Invitations" subtitle="Email delivery is not configured on this server, so copy the invite link and send it yourself. Links expire after 7 days." /></div>
        {pending.length === 0 ? <div className="px-5 pb-5"><Empty title="No pending invitations" body="Invite a colleague to give them access with a specific role." action={<Button size="sm" onClick={() => setOpen(true)} data-testid="members-invite-empty"><UserPlus size={14} />Invite</Button>} /></div> : (
          <Table className="rounded-t-none border-0 shadow-none">
            <thead><tr><Th>Email</Th><Th>Role</Th><Th>Linked employee</Th><Th>Expires</Th><Th></Th></tr></thead>
            <tbody>{pending.map((i) => { const expired = new Date(i.expiresAt) < new Date(); return (
              <tr key={i.id} data-testid={`members-invite-row-${i.id}`}>
                <Td className="text-xs font-medium">{i.email}</Td><Td className="text-xs capitalize">{i.role}</Td><Td className="text-xs">{i.employeeName ?? <span className="text-ink-3">—</span>}</Td>
                <Td className="text-xs whitespace-nowrap">{expired ? <Badge tone="danger">expired</Badge> : date(i.expiresAt, tz)}</Td>
                <Td><Button size="sm" variant="ghost" onClick={() => revoke(i.id)} loading={busy === i.id} aria-label="Revoke invitation" data-testid={`members-revoke-${i.id}`}><Trash2 size={14} /></Button></Td>
              </tr>); })}</tbody>
          </Table>
        )}
        {invitations.some((i) => i.acceptedAt) && <p className="px-5 py-3 text-[11px] text-ink-3">{invitations.filter((i) => i.acceptedAt).length} invitation(s) already accepted.</p>}
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Invite a member">
        <form onSubmit={invite} className="space-y-3">
          <Input type="email" label="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus data-testid="invite-email" />
          <Select label="Role" value={role} onChange={(e) => setRole(e.target.value)} data-testid="invite-role">{ROLES.filter((r) => isOwner || r !== "owner").map((r) => <option key={r} value={r}>{r}</option>)}</Select>
          <p className="text-xs text-ink-2">{ROLE_HELP[role]}</p>
          <Select label="Link to an employee record (optional)" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} data-testid="invite-employee"><option value="">— none —</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}{e.title ? ` · ${e.title}` : ""}</option>)}</Select>
          <p className="text-[11px] text-ink-3">Linking lets the person see their own observed activity under “My data”. It never changes what others can see.</p>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={busy === "invite"} data-testid="invite-submit">Create invitation</Button></div>
        </form>
      </Modal>
      <Modal open={!!link} onClose={() => setLink(null)} title="Invitation created">
        {link && <div className="space-y-3" data-testid="invite-link-modal">
          <p className="text-sm">Email sending is not configured on this server, so share this link yourself. It works once and expires {date(link.expiresAt, tz)}.</p>
          <div className="flex gap-2"><input readOnly value={link.link} className="h-9 flex-1 rounded-lg border border-border bg-surface-2 px-3 font-mono text-xs" data-testid="invite-link" onFocus={(e) => e.currentTarget.select()} /><Button variant="secondary" onClick={copy} data-testid="invite-copy">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}</Button></div>
          <p className="text-[11px] text-ink-3">The link is shown only now; the server stores a hash of it. Revoke it from the invitations list if it leaks.</p>
          <div className="flex justify-end"><Button onClick={() => setLink(null)} data-testid="invite-done">Done</Button></div>
        </div>}
      </Modal>
    </div>
  );
}
