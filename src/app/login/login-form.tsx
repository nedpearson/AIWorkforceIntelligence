"use client";
import * as React from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button, Input, Card } from "@/components/ui";

export function LoginForm({ next, ssoEnabled }: { next: string; ssoEnabled: boolean }) {
  const r = useRouter();
  const [email, setEmail] = React.useState(""); const [password, setPassword] = React.useState(""); const [otp, setOtp] = React.useState("");
  const [needOtp, setNeedOtp] = React.useState(false); const [err, setErr] = React.useState(""); const [busy, setBusy] = React.useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    const res = await signIn("credentials", { email, password, otp, redirect: false });
    setBusy(false);
    if (res?.error) {
      const code = res.code ?? res.error;
      if (String(code).includes("MFA_REQUIRED")) { setNeedOtp(true); setErr("Enter the 6-digit code from your authenticator app."); return; }
      if (String(code).includes("MFA_INVALID")) { setNeedOtp(true); setErr("That code didn't match. Try again."); return; }
      setErr("Email or password is incorrect."); return;
    }
    r.push(next); r.refresh();
  }
  return (
    <Card>
      <form onSubmit={submit} className="space-y-3" data-testid="login-form">
        <Input label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} data-testid="login-email" />
        <Input label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} data-testid="login-password" />
        {needOtp && <Input label="Authenticator code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value)} data-testid="login-otp" autoFocus />}
        {err && <p className="text-xs text-danger" role="alert">{err}</p>}
        <Button type="submit" className="w-full" loading={busy} data-testid="login-submit">Sign in</Button>
        {ssoEnabled && <Button type="button" variant="secondary" className="w-full" onClick={() => signIn("oidc", { callbackUrl: next })}>Continue with Single Sign-On</Button>}
      </form>
    </Card>
  );
}
