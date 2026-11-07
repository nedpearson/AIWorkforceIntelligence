import { LoginForm } from "./login-form";
import { demoLoginsAllowed } from "@/lib/runtime-env";
export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-lg font-bold text-white">B</div>
          <h1 className="text-xl font-semibold">BridgeBox</h1>
          <p className="text-sm text-ink-2">AI Workforce Intelligence</p>
        </div>
        <LoginForm next={sp.next ?? "/app"} ssoEnabled={!!process.env.OIDC_ISSUER} />
        {/* SEC-001: never advertise demo accounts where they cannot (and must not) sign in. */}
        {demoLoginsAllowed() && <p className="mt-6 text-center text-[11px] text-ink-3" data-testid="login-demo-hint">Demo accounts are listed in README.md. All demo data is synthetic.</p>}
      </div>
    </main>
  );
}
