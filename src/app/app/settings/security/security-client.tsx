"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { ShieldCheck, ShieldOff, KeyRound } from "lucide-react";
import { Badge, Button, Card, CardHeader, Input, Modal } from "@/components/ui";
import { cn } from "@/lib/utils";
import { changePassword, mfaConfirm, mfaDisable, mfaStart, setMfaPolicy, signOutAllSessions } from "../actions";
import { useTimeZone } from "@/components/time-zone";
import { formatDateTime } from "@/lib/datetime";

type Flash = { ok: boolean; text: string } | null;
const date = (s: string | null, tz: string) => (s ? formatDateTime(s, tz, { dateStyle: "medium", timeStyle: "short" }) : "never");

type Policy = { orgRequiresMfa: boolean; canEdit: boolean; required: boolean; reason: "org_policy" | "platform_owner" | null; gateHit: boolean };
/** After a password/MFA change or "sign out everywhere" the session version was bumped: this cookie is dead, so clear it. */
const reauth = (why: string) => signOut({ callbackUrl: `/login?reauth=${why}` });

export function SecurityClient({ user, session, sso, vaultReady, policy }: { user: { email: string; name: string; mfaEnabled: boolean; hasPassword: boolean; sso: boolean; lastLoginAt: string | null; createdAt: string }; session: { role: string; orgName: string; strategy: string }; sso: { configured: boolean; vars: [string, boolean][] }; vaultReady: boolean; policy: Policy }) {
  const tz = useTimeZone();
  const router = useRouter();
  const [flash, setFlash] = React.useState<Flash>(null);
  const [enroll, setEnroll] = React.useState<{ qrDataUrl: string; manualKey: string } | null>(null);
  const [code, setCode] = React.useState(""); const [busy, setBusy] = React.useState("");
  const [disable, setDisable] = React.useState(false); const [dpw, setDpw] = React.useState(""); const [dcode, setDcode] = React.useState("");
  const [pw, setPw] = React.useState({ current: "", next: "", confirm: "" });
  const [requireMfa, setRequireMfa] = React.useState(policy.orgRequiresMfa);
  async function savePolicy() { setBusy("policy"); const r = await setMfaPolicy({ requireMfaForAdmins: requireMfa }); setBusy(""); setFlash(r.ok ? { ok: true, text: requireMfa ? "Owners and admins must now set up MFA." : "MFA is now optional for owners and admins." } : { ok: false, text: r.error }); if (r.ok) router.refresh(); }
  async function revokeAll(scope: "me" | "org") {
    if (!window.confirm(scope === "me" ? "Sign out of every device, including this one?" : "Sign out every member of this organization, including you?")) return;
    setBusy("revoke-" + scope); const r = await signOutAllSessions({ scope }); setBusy("");
    if (r.ok) await reauth("signed-out"); else setFlash({ ok: false, text: r.error });
  }
  async function start() { setBusy("start"); const r = await mfaStart(); setBusy(""); if (r.ok) { setEnroll({ qrDataUrl: r.qrDataUrl, manualKey: r.manualKey }); setCode(""); } else setFlash({ ok: false, text: r.error }); }
  async function confirm(e: React.FormEvent) { e.preventDefault(); setBusy("confirm"); const r = await mfaConfirm({ code }); setBusy(""); if (r.ok) { setEnroll(null); setFlash({ ok: true, text: "Two-factor authentication is on. Sign in again with your code — all sessions were signed out." }); await reauth("mfa-enabled"); } else setFlash({ ok: false, text: r.error }); }
  async function doDisable(e: React.FormEvent) { e.preventDefault(); setBusy("disable"); const r = await mfaDisable({ password: dpw, code: dcode }); setBusy(""); if (r.ok) { setDisable(false); setDpw(""); setDcode(""); setFlash({ ok: true, text: "Two-factor authentication is off. All sessions were signed out." }); await reauth("mfa-disabled"); } else setFlash({ ok: false, text: r.error }); }
  async function doPassword(e: React.FormEvent) { e.preventDefault(); setBusy("pw"); const r = await changePassword(pw); setBusy(""); if (r.ok) { setPw({ current: "", next: "", confirm: "" }); setFlash({ ok: true, text: "Password changed. All sessions were signed out." }); await reauth("password-changed"); } else setFlash({ ok: false, text: r.error }); }
  return (
    <div className="space-y-5" data-testid="security-page">
      {policy.required && !user.mfaEnabled && (
        <div className="rounded-lg border border-warn bg-warn-soft px-3 py-2 text-xs text-ink" role="alert" data-testid="mfa-required-banner">
          <strong>Set up two-factor authentication to continue.</strong>{" "}
          {policy.reason === "platform_owner" ? "The platform owner account manages every client organization, so MFA is required for it." : "Your organization requires MFA for owners and admins."}{" "}
          {policy.gateHit ? "Other pages open again once MFA is on." : "Until then the rest of the app sends you back here."} Your sign-in is never blocked: this page always stays available.
        </div>
      )}
      {flash && <div className={cn("rounded-lg px-3 py-2 text-xs", flash.ok ? "bg-money-soft text-money" : "bg-danger-soft text-danger")} role="status" data-testid="security-flash">{flash.text}</div>}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card data-testid="security-mfa">
          <CardHeader title="Two-factor authentication (MFA)" subtitle="A 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy) in addition to your password." action={user.mfaEnabled ? <Badge tone="verified"><ShieldCheck size={11} className="mr-1" />on</Badge> : <Badge tone="warn"><ShieldOff size={11} className="mr-1" />off</Badge>} />
          {!vaultReady && <p className="mb-3 rounded-lg bg-danger-soft p-2 text-xs text-danger" data-testid="security-vault-missing">VAULT_KEY is not set, so MFA secrets cannot be encrypted. Set it on the server first.</p>}
          {user.mfaEnabled ? (
            <div className="space-y-2 text-sm"><p className="text-xs text-ink-2">MFA is enabled for {user.email}. Disabling requires your password and a current code.</p><Button variant="secondary" size="sm" onClick={() => setDisable(true)} data-testid="mfa-disable">Disable MFA</Button></div>
          ) : enroll ? (
            <form onSubmit={confirm} className="space-y-3" data-testid="mfa-enroll">
              <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={enroll.qrDataUrl} alt="MFA QR code" width={160} height={160} className="rounded-lg border border-border bg-white p-1" data-testid="mfa-qr" />
                <div className="text-xs text-ink-2"><p>1. Scan this with your authenticator app, or enter the key manually:</p><code className="mt-1 block break-all rounded bg-surface-2 p-2 font-mono text-[11px]" data-testid="mfa-manual-key">{enroll.manualKey}</code><p className="mt-2">2. Enter the 6-digit code it shows to finish.</p></div>
              </div>
              <div className="flex gap-2"><Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" pattern="\d{6}" maxLength={6} placeholder="123456" aria-label="6-digit code" data-testid="mfa-code" /><Button type="submit" loading={busy === "confirm"} data-testid="mfa-confirm">Verify & enable</Button><Button type="button" variant="ghost" onClick={() => setEnroll(null)}>Cancel</Button></div>
            </form>
          ) : (
            <Button size="sm" onClick={start} loading={busy === "start"} disabled={!vaultReady} data-testid="mfa-start"><ShieldCheck size={14} />Set up MFA</Button>
          )}
        </Card>
        <Card data-testid="security-password">
          <CardHeader title="Password" subtitle={user.hasPassword ? "At least 10 characters. Changing it signs out every device, including this one." : "This account signs in with SSO and has no local password."} />
          {user.hasPassword && (
            <form onSubmit={doPassword} className="space-y-2">
              <Input type="password" label="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" required data-testid="pw-current" />
              <Input type="password" label="New password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" minLength={10} required data-testid="pw-next" />
              <Input type="password" label="Confirm new password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" required data-testid="pw-confirm" />
              <Button type="submit" size="sm" loading={busy === "pw"} data-testid="pw-submit"><KeyRound size={14} />Change password</Button>
            </form>
          )}
        </Card>
        <Card data-testid="security-session">
          <CardHeader title="Your session" />
          <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 text-xs">
            <dt className="text-ink-3">Signed in as</dt><dd>{user.name ? `${user.name} · ` : ""}{user.email}</dd>
            <dt className="text-ink-3">Role</dt><dd><span className="capitalize">{session.role}</span> in {session.orgName}</dd>
            <dt className="text-ink-3">Sign-in method</dt><dd>{user.sso ? "Single sign-on" : "Email + password"}{user.mfaEnabled ? " + MFA" : ""}</dd>
            <dt className="text-ink-3">Session</dt><dd>{session.strategy}</dd>
            <dt className="text-ink-3">Last sign-in</dt><dd>{date(user.lastLoginAt, tz)}</dd>
            <dt className="text-ink-3">Account created</dt><dd>{date(user.createdAt, tz)}</dd>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" loading={busy === "revoke-me"} onClick={() => revokeAll("me")} data-testid="sessions-signout-all">Sign out all my sessions</Button>
            {policy.canEdit && <Button size="sm" variant="secondary" loading={busy === "revoke-org"} onClick={() => revokeAll("org")} data-testid="sessions-signout-org">Sign out everyone in {session.orgName}</Button>}
          </div>
          <p className="mt-2 text-[11px] text-ink-3">Changing your password or MFA also signs out every session.</p>
        </Card>
        <Card data-testid="security-mfa-policy">
          <CardHeader title="MFA policy" subtitle="Require owners and admins (and consultants working in this organization) to use two-factor authentication. Anyone affected is sent to this page until they enrol — nobody is locked out." action={policy.orgRequiresMfa ? <Badge tone="verified">required</Badge> : <Badge tone="neutral">optional</Badge>} />
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={requireMfa} disabled={!policy.canEdit} onChange={(e) => setRequireMfa(e.target.checked)} data-testid="mfa-policy-require" />Require MFA for owners and admins</label>
          {policy.canEdit ? <Button size="sm" className="mt-3" loading={busy === "policy"} disabled={requireMfa === policy.orgRequiresMfa} onClick={savePolicy} data-testid="mfa-policy-save">Save policy</Button> : <p className="mt-2 text-[11px] text-ink-3">Only an owner can change this.</p>}
        </Card>
        <Card data-testid="security-sso">
          <CardHeader title="Single sign-on (OIDC)" subtitle="Entra ID, Okta or Google Workspace. Configured by environment variables on the server, not per organization." action={sso.configured ? <Badge tone="verified">configured</Badge> : <Badge tone="neutral">not configured</Badge>} />
          <ul className="space-y-1 text-xs">{sso.vars.map(([k, v]) => <li key={k} className="flex items-center gap-2"><span className={cn("h-2 w-2 rounded-full", v ? "bg-verified" : "bg-ink-3")} /><code>{k}</code><span className="text-ink-3">{v ? "set" : "missing"}</span></li>)}</ul>
          {!sso.configured && <p className="mt-2 text-[11px] text-ink-3">Set all three and restart the server; a “Single Sign-On” button then appears on the login page. Users are created on first sign-in and must still be invited to an organization.</p>}
        </Card>
      </div>
      <Modal open={disable} onClose={() => setDisable(false)} title="Disable two-factor authentication">
        <form onSubmit={doDisable} className="space-y-3" data-testid="mfa-disable-modal">
          <Input type="password" label="Password" value={dpw} onChange={(e) => setDpw(e.target.value)} autoComplete="current-password" required data-testid="mfa-disable-password" />
          <Input label="Current 6-digit code" value={dcode} onChange={(e) => setDcode(e.target.value)} inputMode="numeric" maxLength={6} required data-testid="mfa-disable-code" />
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setDisable(false)}>Cancel</Button><Button type="submit" variant="danger" loading={busy === "disable"} data-testid="mfa-disable-confirm">Disable MFA</Button></div>
        </form>
      </Modal>
    </div>
  );
}
