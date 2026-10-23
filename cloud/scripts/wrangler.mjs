// Runs wrangler with this station's config (see config.mjs):
//   node scripts/wrangler.mjs secret put RESEND_API_KEY
import { spawnSync } from "node:child_process";
import { cloud, configFile } from "./config.mjs";

const args = [...process.argv.slice(2), "--config", configFile];
const r = spawnSync("npx", ["wrangler", ...args], { cwd: cloud, stdio: "inherit" });
process.exit(r.status ?? 1);
