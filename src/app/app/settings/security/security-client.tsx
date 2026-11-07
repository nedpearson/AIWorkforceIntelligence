"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, ShieldOff, KeyRound } from "lucide-react";
import { Badge, Button, Card, CardHeader, Input, Modal } from "@/components/ui";
import { cn } from "@/lib/utils";
import { changePassword, mfaConfirm, mfaDisable, mfaStart } from "../actions";
import { useTimeZone } from "@/components/time-zone";
import { formatDateTime } from "@/lib/datetime";

type Flash = { ok: boolean; text: string } | null;
const date = (s: string | null, tz: string) => (s ? formatDateTime(s, tz, { dateStyle: "medium", timeStyle: "short" }) : "never");

export function SecurityClient({ user, session, sso, vaultReady }: { user: { email: string; name: string; mfaEnabled: boolean; hasPassword: boolean; sso: boolean; lastLoginAt: string | null; createdAt: string }; session: { role: string; orgName: string; strategy: string }; sso: { configured: boolean; vars: [string, boolean][] }; vaultReady: boolean }) {
  const tz = useTimeZone();
  const router = useRouter();
  const [flash, setFlash] = React.useState<Flash>(null);
  const [enroll, setEnroll] = React.useState<{ qrDataUrl: string; manualKey: string } | null>(null);
  const [code, setCode] = React.useState(""); const [busy, setBusy] = React.useState("");
  const [disable, setDisable] = React.useState(false); const [dpw, setDpw] = React.useState(""); const [dcode, setDcode] = React.useState("");
  const [pw, setPw] = React.useState({ current: "", next: "", confirm: "" });
  async function start() { setBusy("start"); const r = await mfaStart(); setBusy(""); if (r.ok) { setEnroll({ qrDataUrl: r.qrDataUrl, manualKey: r.manualKey }); setCode(""); } else setFlash({ ok: false, text: r.error }); }
  async function confirm(e: React.FormEvent) { e.preventDefault(); setBusy("confirm"); const r = await mfaConfirm({ code }); setBusy(""); if (r.ok) { setEnroll(null); setFlash({ ok: true, text: "Two-factor authentication is on. You will be asked for a code at every sign-in." }); router.refresh(); } else setFlash({ ok: false, text: r.error }); }
  async function doDisable(e: React.FormEvent) { e.preventDefault(); setBusy("disable"); const r = await mfaDisable({ password: dpw, code: dcode }); setBusy(""); if (r.ok) { setDisable(false); setDpw(""); setDcode(""); setFlash({ ok: true, text: "Two-factor authentication is off." }); router.refresh(); } else setFlash({ ok: false, text: r.error }); }
  async function doPassword(e: React.FormEvent) { e.preventDefault(); setBusy("pw"); const r = await changePassword(pw); setBusy(""); if (r.ok) { setPw({ current: "", next: "", confirm: "" }); setFlash({ ok: true, text: "Password changed." }); } else setFlash({ ok: false, text: r.error }); }
  return (
    <div className="space-y-5" data-testid="security-page">
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
          <CardHeader title="Password" subtitle={user.hasPassword ? "At least 10 characters. Changing it does not sign out other devices." : "This account signs in with SSO and has no local password."} />
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
