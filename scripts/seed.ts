import "dotenv/config";
import { seedDemo } from "../src/engine/seed";
seedDemo().then((r) => { if (r.skipped) console.log("already seeded; run db:reset first"); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
