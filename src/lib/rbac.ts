export type Role = "owner" | "admin" | "manager" | "employee" | "consultant" | "viewer";
/** Permission matrix. Keep flat and explicit: it is rendered in docs/SECURITY.md. */
export const PERMISSIONS = {
  "org:manage": ["owner", "admin", "consultant"],
  "org:billing": ["owner", "consultant"],
  "members:invite": ["owner", "admin", "consultant"],
  "employees:read": ["owner", "admin", "manager", "consultant", "viewer"],
  "employees:cost:read": ["owner", "admin", "consultant"],
  "employees:write": ["owner", "admin", "consultant"],
  "collectors:manage": ["owner", "admin", "consultant"],
  "campaigns:manage": ["owner", "admin", "consultant"],
  "analysis:run": ["owner", "admin", "consultant"],
  "workflows:read": ["owner", "admin", "manager", "consultant", "viewer"],
  "opportunities:read": ["owner", "admin", "manager", "consultant", "viewer"],
  "opportunities:write": ["owner", "admin", "consultant"],
  "agents:read": ["owner", "admin", "manager", "consultant", "viewer"],
  "agents:write": ["owner", "admin", "consultant"],
  "agents:approve": ["owner", "admin", "manager"],
  "credentials:manage": ["owner", "admin"],
  "finance:read": ["owner", "admin", "manager", "consultant", "viewer"],
  "finance:write": ["owner", "admin", "consultant"],
  "reports:generate": ["owner", "admin", "consultant"],
  "self:read": ["owner", "admin", "manager", "employee", "consultant", "viewer"],
  "audit:read": ["owner", "admin", "consultant"],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;
export function can(role: Role | null | undefined, p: Permission): boolean {
  return !!role && (PERMISSIONS[p] as readonly Role[]).includes(role);
}
