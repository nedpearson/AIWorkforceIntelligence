import "dotenv/config";
import postgres from "postgres";
async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, ssl: process.env.DATABASE_SSL === "require" ? "require" : undefined });
  const s = process.env.DB_SCHEMA?.trim() || "public";
  if (s === "public") await sql.unsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;`);
  else await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE; DROP SCHEMA IF EXISTS "${s}_drizzle" CASCADE; CREATE SCHEMA "${s}";`);
  console.log("schema reset"); await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
