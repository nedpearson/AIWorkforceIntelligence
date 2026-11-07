"use client";
import * as React from "react";
import { signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button, Card, Input, Badge } from "@/components/ui";
import { LinkButton } from "@/components/admin/link-button";
import { acceptAsExisting, acceptAsNew } from "./actions";

type Invite = { orgName: string; email: string; role: string; userExists: boolean; expiresAt: string };
export function AcceptInvite({ token, invite, invalid, signedInAs }: { token: string; invite?: Invite; invalid?: "not_found" | "expired" | "accepted"; signedInAs?: string | null }) {
  const r = useRouter();
  const [name, setName] = React.useState(""); const [password, setPassword] = React.useState(""); const [password2, setPassword2] = React.useState("");
  const [loginPw, setLoginPw] = React.useState(""); const [otp, setOtp] = React.useState(""); const [needOtp, setNeedOtp] = React.useState(false);
  const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState("");

  if (invalid) {
    const msg = invalid === "expired" ? "This invitation has expired. Ask the person who invited you for a new link." : invalid === "accepted" ? "This invitation was already used. Sign in instead." : "This invitation link is not valid.";
    return <Card data-testid="invite-invalid"><p className="text-sm">{msg}</p><LinkButton className="mt-4 w-full" href="/login" data-testid="invite-go-login">Go to sign in</LinkButton></Card>;
  }
  const inv = invite!;
  const matches = !!signedInAs && signedInAs.toLowerCase() === inv.email.toLowerCase();

  async function finish(orgId: string) { void orgId; r.push("/app"); r.refresh(); }
  async function acceptExisting() { setBusy(true); setErr(""); const res = await acceptAsExisting({ token }); setBusy(false); if (!res.ok) { setErr(res.error); return; } finish(res.orgId); }
  async function signInThenAccept(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    const res = await signIn("credentials", { email: inv.email, password: loginPw, otp, redirect: false });
    if (res?.error) { setBusy(false); const code = String(res.code ?? res.error); if (code.includes("MFA_REQUIRED")) { setNeedOtp(true); setErr("Enter the 6-digit code from your authenticator app."); return; } if (code.includes("MFA_INVALID")) { setNeedOtp(true); setErr("That code didn't match."); return; } setErr("Email or password is incorrect."); return; }
    const acc = await acceptAsExisting({ token }); setBusy(false);
    if (!acc.ok) { setErr(acc.error); return; } finish(acc.orgId);
  }
  async function createAndAccept(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    if (password.length < 10) { setErr("Password must be at least 10 characters."); return; }
    if (password !== password2) { setErr("Passwords do not match."); return; }
    setBusy(true);
    const res = await acceptAsNew({ token, name, password });
    if (!res.ok) { setBusy(false); setErr(res.error); return; }
    const si = await signIn("credentials", { email: inv.email, password, redirect: false });
    setBusy(false);
    if (si?.error) { setErr("Account created, but sign-in failed. Go to the sign-in page and use your new password."); return; }
    finish(res.orgId);
  }

  return (
    <Card data-testid="invite-card">
      <div className="mb-4">
        <h2 className="text-base font-semibold">You&apos;re invited to {inv.orgName}</h2>
        <p className="mt-1 text-sm text-ink-2">as <Badge tone="brand">{inv.role}</Badge> · for <strong>{inv.email}</strong> · expires {new Date(inv.expiresAt).toLocaleDateString()}</p>
      </div>
      {err && <p className="mb-3 rounded-lg bg-danger-soft p-2 text-xs text-danger" role="alert" data-testid="invite-error">{err}</p>}
      {matches ? (
        <div className="space-y-3" data-testid="invite-accept-existing">
          <p className="text-sm">You are signed in as {signedInAs}.</p>
          <Button className="w-full" onClick={acceptExisting} loading={busy} data-testid="invite-accept">Accept invitation</Button>
        </div>
      ) : signedInAs && !matches ? (
        <div className="space-y-3" data-testid="invite-wrong-user">
          <p className="text-sm">You are signed in as {signedInAs}, but this invitation is for {inv.email}.</p>
          <Button variant="secondary" className="w-full" onClick={() => signOut({ callbackUrl: `/invite/${token}` })} data-testid="invite-switch-user">Sign out and continue</Button>
        </div>
      ) : inv.userExists ? (
        <form onSubmit={signInThenAccept} className="space-y-3" data-testid="invite-signin-form">
          <p className="text-sm">An account already exists for {inv.email}. Sign in to accept.</p>
          <Input label="Password" type="password" autoComplete="current-password" required value={loginPw} onChange={(e) => setLoginPw(e.target.value)} data-testid="invite-login-password" />
          {needOtp && <Input label="Authenticator code" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value)} data-testid="invite-login-otp" />}
          <Button type="submit" className="w-full" loading={busy} data-testid="invite-signin-accept">Sign in and accept</Button>
        </form>
      ) : (
        <form onSubmit={createAndAccept} className="space-y-3" data-testid="invite-create-form">
          <Input label="Your name" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} data-testid="invite-name" />
          <Input label="Email" value={inv.email} readOnly data-testid="invite-email" />
          <Input label="Password" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} data-testid="invite-password" hint="At least 10 characters." />
          <Input label="Confirm password" type="password" autoComplete="new-password" required value={password2} onChange={(e) => setPassword2(e.target.value)} data-testid="invite-password2" />
          <Button type="submit" className="w-full" loading={busy} data-testid="invite-create-accept">Create account and accept</Button>
        </form>
      )}
    </Card>
  );
}
