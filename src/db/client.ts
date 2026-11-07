import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/** Optional: run the whole app inside a dedicated Postgres schema (shared database deployments). */
export const DB_SCHEMA = process.env.DB_SCHEMA?.trim() || undefined;
const globalForDb = globalThis as unknown as { pg?: ReturnType<typeof postgres> };
export const pg = globalForDb.pg ?? postgres(process.env.DATABASE_URL!, {
  max: 10, prepare: false,
  ...(DB_SCHEMA ? { connection: { search_path: `${DB_SCHEMA},public` } } : {}),
  ssl: process.env.DATABASE_SSL === "require" ? "require" : undefined,
});
if (process.env.NODE_ENV !== "production") globalForDb.pg = pg;

/** Admin (bypass-RLS) handle. Use only in auth, ingestion-token lookup, jobs and system code. */
export const db = drizzle(pg, { schema });
export type Db = typeof db;
export { schema };
