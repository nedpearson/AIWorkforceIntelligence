import "server-only";
import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { audit } from "./audit";
import { authorizeCredentials } from "./authorize";
import type { Role } from "./rbac";

declare module "next-auth" {
  interface Session { user: { id: string; email: string; name?: string | null; mfaEnabled: boolean; sv: number } & DefaultSession["user"] }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providers: any[] = [
  Credentials({
    credentials: { email: {}, password: {}, otp: {} },
    // Rate limits, SEC-001 demo-account refusal, bcrypt, TOTP: src/lib/authorize.ts
    authorize: (c, req) => authorizeCredentials(c, req),
  }),
];
// Generic OIDC SSO (Entra ID / Okta / Google Workspace). Enabled only when env is present.
if (process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID) {
  providers.push({
    id: "oidc", name: "Single Sign-On", type: "oidc",
    issuer: process.env.OIDC_ISSUER, clientId: process.env.OIDC_CLIENT_ID, clientSecret: process.env.OIDC_CLIENT_SECRET,
    profile: (p: Record<string, unknown>) => ({ id: String(p.sub), email: String(p.email), name: String(p.name ?? p.email) }),
  } as never);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt", maxAge: 60 * 60 * 12 },
  pages: { signIn: "/login" },
  callbacks: {
    async jwt({ token, user, account }) {
      if (user) { token.uid = user.id; token.mfaEnabled = (user as { mfaEnabled?: boolean }).mfaEnabled ?? false; token.sv = (user as { sessionVersion?: number }).sessionVersion ?? 0; }
      if (account?.provider === "oidc" && token.email) {
        // Just-in-time user creation for SSO
        const email = String(token.email).toLowerCase();
        const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
        if (existing) { token.uid = existing.id; token.mfaEnabled = existing.mfaEnabled; token.sv = existing.sessionVersion; }
        else {
          const [created] = await db.insert(schema.users).values({ email, name: token.name, ssoSubject: token.sub, emailVerified: new Date() }).returning();
          token.uid = created.id; token.mfaEnabled = false; token.sv = created.sessionVersion;
          await audit({ actorUserId: created.id, action: "auth.sso_jit_user_created" });
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = String(token.uid);
      session.user.mfaEnabled = Boolean(token.mfaEnabled);
      session.user.sv = Number(token.sv ?? 0);
      return session;
    },
  },
  trustHost: true,
});

export type Ctx = { userId: string; email: string; orgId: string; role: Role; orgKind: "consultancy" | "client"; orgName: string; employeeId: string | null;
  /** From users.mfa_enabled (DB, not the token) and src/lib/mfa-policy.ts. */
  mfaEnabled?: boolean; mfaRequired?: boolean; mfaRequiredReason?: "org_policy" | "platform_owner" | "platform_owner_grace" | null; mfaGraceUntil?: string | null };
