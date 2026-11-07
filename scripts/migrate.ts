import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readFileSync } from "node:fs";
import path from "node:path";

async function main() {
  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  await sql.unsafe(readFileSync(path.join(process.cwd(), "drizzle/rls.sql"), "utf8"));
  console.log("migrations + RLS applied");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
