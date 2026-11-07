import "dotenv/config";
import { runMigrations } from "../src/engine/migrate";
runMigrations().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
