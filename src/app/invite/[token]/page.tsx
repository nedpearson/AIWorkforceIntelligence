import { getValidSession } from "@/lib/session";
import { lookupInvitation } from "@/engine/onboarding";
import { AcceptInvite } from "./accept-invite";

export const metadata = { title: "Accept invitation" };
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const look = await lookupInvitation(token);
  const s = await getValidSession();
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-lg font-bold text-white">B</div>
          <h1 className="text-xl font-semibold">BridgeBox</h1>
          <p className="text-sm text-ink-2">AI Workforce Intelligence</p>
        </div>
        {!look.ok ? <AcceptInvite token={token} invalid={look.reason} /> : <AcceptInvite token={token} invite={{ orgName: look.orgName, email: look.email, role: look.role, userExists: look.userExists, expiresAt: look.expiresAt.toISOString() }} signedInAs={s?.user?.email ?? null} />}
      </div>
    </main>
  );
}
