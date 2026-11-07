import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { pg } from "./client";
import * as schema from "./schema";

/**
 * Run `fn` inside a transaction with the Postgres session variable `app.current_org` set.
 * RLS policies (drizzle/rls.sql) read this variable. The transaction also switches to the
 * non-superuser `bridgebox_app` role when it exists so RLS is actually enforced (superusers bypass RLS).
 */
export async function withTenant<T>(orgId: string, fn: (tx: TenantDb) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error("withTenant: invalid orgId");
  const base = drizzle(pg, { schema });
  return base.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org', ${orgId}, true)`);
    await tx.execute(sql`select set_config('role', 'bridgebox_app', true)`);
    return fn(tx as unknown as TenantDb);
  });
}
export type TenantDb = ReturnType<typeof drizzle<typeof schema>>;
