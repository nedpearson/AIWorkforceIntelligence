"use client";
import * as React from "react";
import { Button, Badge, Card, CardHeader, PageHeader, Table, Th, Td, Input, Select } from "@/components/ui";
import { inviteConsultant, setMemberRole, removeMember, revokeInvitation } from "@/app/admin/team/actions";
import { useAction, ErrorNote } from "./client-workspace";
import { useTimeZone } from "@/components/time-zone";
import { formatDate, formatDateTime } from "@/lib/datetime";

type Member = { id: string; userId: string; role: string; name: string | null; email: string; lastLoginAt: string | null; mfa: boolean; createdAt: string };
type Invite = { id: string; email: string; role: string; expiresAt: string; acceptedAt: string | null; createdAt: string };

export function TeamView({ me, members, invites }: { me: { userId: string; role: string }; members: Member[]; invites: Invite[] }) {
  const tz = useTimeZone();
  const a = useAction(); const inv = useAction();
  const [f, setF] = React.useState({ email: "", role: "consultant" }); const [url, setUrl] = React.useState("");
  const isOwner = me.role === "owner"; const canInvite = ["owner", "admin"].includes(me.role);
  const open = invites.filter((i) => !i.acceptedAt && new Date(i.expiresAt).getTime() > Date.now());
  return (
    <div data-testid="team-page">
      <PageHeader title="Consultancy team" subtitle="Who can use this portal. Consultants act inside every client workspace with the consultant role." />
      <ErrorNote error={a.error} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <Table><thead><tr><Th>Member</Th><Th>Role</Th><Th>MFA</Th><Th>Last sign-in</Th><Th></Th></tr></thead><tbody>{members.map((m) => (
            <tr key={m.id} data-testid={`member-row-${m.id}`}>
              <Td><div className="font-medium">{m.name ?? m.email}</div><div className="text-xs text-ink-2">{m.email}{m.userId === me.userId && " (you)"}</div></Td>
              <Td>{isOwner && m.userId !== me.userId ? <select className="h-8 rounded-lg border border-border bg-surface px-2 text-xs" defaultValue={m.role} onChange={(e) => a.run(() => setMemberRole({ membershipId: m.id, role: e.target.value }))} data-testid={`member-role-${m.id}`}>{["owner", "admin", "consultant", "viewer"].map((r) => <option key={r} value={r}>{r}</option>)}</select> : <Badge tone="brand">{m.role}</Badge>}</Td>
              <Td>{m.mfa ? <Badge tone="money">on</Badge> : <Badge tone="warn">off</Badge>}</Td><Td className="text-xs">{m.lastLoginAt ? formatDateTime(m.lastLoginAt, tz) : "never"}</Td>
              <Td>{isOwner && m.userId !== me.userId && <Button size="sm" variant="ghost" onClick={() => confirm(`Remove ${m.email} from the consultancy?`) && a.run(() => removeMember({ membershipId: m.id }))} data-testid={`member-remove-${m.id}`}>Remove</Button>}</Td>
            </tr>))}</tbody></Table>
          <Card>
            <CardHeader title={`Open invitations (${open.length})`} subtitle="Links expire after 14 days." />
            {!open.length ? <p className="text-xs text-ink-2" data-testid="invites-empty">No open invitations.</p> : (
              <Table><thead><tr><Th>Email</Th><Th>Role</Th><Th>Expires</Th><Th></Th></tr></thead><tbody>{open.map((i) => (
                <tr key={i.id} data-testid={`invite-row-${i.id}`}><Td>{i.email}</Td><Td><Badge tone="neutral">{i.role}</Badge></Td><Td className="text-xs">{formatDate(i.expiresAt, tz)}</Td><Td>{canInvite && <Button size="sm" variant="ghost" onClick={() => a.run(() => revokeInvitation({ invitationId: i.id }))} data-testid={`invite-revoke-${i.id}`}>Revoke</Button>}</Td></tr>))}</tbody></Table>
            )}
          </Card>
        </div>
        <Card>
          <CardHeader title="Invite a consultant" subtitle={canInvite ? "Creates a one-time link you send yourself." : "Only owners and admins can invite."} />
          <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const r = await inv.run(() => inviteConsultant(f)); if (r) { setUrl(r.url); setF({ email: "", role: "consultant" }); } }}>
            <Input label="Email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} disabled={!canInvite} data-testid="team-invite-email" />
            <Select label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} disabled={!canInvite} data-testid="team-invite-role"><option value="admin">admin — manage clients, billing and team</option><option value="consultant">consultant — work inside client workspaces</option><option value="viewer">viewer — read only</option></Select>
            <ErrorNote error={inv.error} />
            {url && <div className="rounded-lg bg-surface-2 p-2 font-mono text-[11px] break-all" data-testid="team-invite-link">{url}</div>}
            <Button type="submit" loading={inv.busy} disabled={!canInvite} data-testid="team-invite-submit">Create invitation link</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
