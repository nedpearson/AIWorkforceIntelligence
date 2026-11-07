import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { SettingsNav } from "./settings-nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx("org:manage");
  const tabs = [
    { href: "/app/settings", label: "Organization", testid: "settings-tab-org" },
    ...(can(ctx.role, "members:invite") ? [{ href: "/app/settings/members", label: "Members & invitations", testid: "settings-tab-members" }] : []),
    { href: "/app/settings/security", label: "Security", testid: "settings-tab-security" },
    { href: "/app/settings/integrations", label: "Integrations", testid: "settings-tab-integrations" },
    ...(can(ctx.role, "audit:read") ? [{ href: "/app/settings/audit", label: "Audit log", testid: "settings-tab-audit" }] : []),
    { href: "/app/settings/data", label: "Data & privacy", testid: "settings-tab-data" },
  ];
  return (
    <div data-testid="settings-page">
      <div className="mb-5"><h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Settings</h1><p className="mt-1 text-sm text-ink-2">{ctx.orgName}</p></div>
      <SettingsNav tabs={tabs} />
      <div className="mt-5">{children}</div>
    </div>
  );
}
