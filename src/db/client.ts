import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { pg?: ReturnType<typeof postgres> };
export const pg = globalForDb.pg ?? postgres(process.env.DATABASE_URL!, { max: 10, prepare: false });
if (process.env.NODE_ENV !== "production") globalForDb.pg = pg;

/** Admin (bypass-RLS) handle. Use only in auth, ingestion-token lookup, jobs and system code. */
export const db = drizzle(pg, { schema });
export type Db = typeof db;
export { schema };
