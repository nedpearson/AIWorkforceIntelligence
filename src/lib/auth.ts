import "server-only";
import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { mfaVerify } from "./mfa";
import { db, schema } from "@/db/client";
import { decrypt } from "./crypto";
import { audit } from "./audit";
import type { Role } from "./rbac";

declare module "next-auth" {
  interface Session { user: { id: string; email: string; name?: string | null; mfaEnabled: boolean } & DefaultSession["user"] }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providers: any[] = [
  Credentials({
    credentials: { email: {}, password: {}, otp: {} },
    async authorize(c) {
      const email = String(c?.email ?? "").toLowerCase().trim();
      const password = String(c?.password ?? "");
      const otp = String(c?.otp ?? "");
      const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
      if (!u?.passwordHash) return null;
      const ok = await bcrypt.compare(password, u.passwordHash);
      if (!ok) { await audit({ action: "auth.login_failed", details: { email } }); return null; }
      if (u.mfaEnabled) {
        if (!u.mfaSecretEnc || !otp) throw new Error("MFA_REQUIRED");
        const valid = await mfaVerify(decrypt(u.mfaSecretEnc), otp);
        if (!valid) { await audit({ actorUserId: u.id, action: "auth.mfa_failed" }); throw new Error("MFA_INVALID"); }
      }
      await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, u.id));
      await audit({ actorUserId: u.id, action: "auth.login" });
      return { id: u.id, email: u.email, name: u.name, mfaEnabled: u.mfaEnabled };
    },
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
      if (user) { token.uid = user.id; token.mfaEnabled = (user as { mfaEnabled?: boolean }).mfaEnabled ?? false; }
      if (account?.provider === "oidc" && token.email) {
        // Just-in-time user creation for SSO
        const email = String(token.email).toLowerCase();
        const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
        if (existing) { token.uid = existing.id; token.mfaEnabled = existing.mfaEnabled; }
        else {
          const [created] = await db.insert(schema.users).values({ email, name: token.name, ssoSubject: token.sub, emailVerified: new Date() }).returning();
          token.uid = created.id; token.mfaEnabled = false;
          await audit({ actorUserId: created.id, action: "auth.sso_jit_user_created" });
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = String(token.uid);
      session.user.mfaEnabled = Boolean(token.mfaEnabled);
      return session;
    },
  },
  trustHost: true,
});

export type Ctx = { userId: string; email: string; orgId: string; role: Role; orgKind: "consultancy" | "client"; orgName: string; employeeId: string | null };
