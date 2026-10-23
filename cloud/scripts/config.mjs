// Which wrangler config this station uses. wrangler.jsonc is the template in
// the repository; a station keeps its real settings (database id, emails,
// domain) in wrangler.local.jsonc next to it, which git ignores. When that
// file exists every npm script uses it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const cloud = join(dirname(fileURLToPath(import.meta.url)), "..");
export const configFile = existsSync(join(cloud, "wrangler.local.jsonc")) ? "wrangler.local.jsonc" : "wrangler.jsonc";

// One of the config's vars, e.g. configVar("CONTACT_EMAIL"); "" when unset.
export function configVar(name) {
  const text = readFileSync(join(cloud, configFile), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const m = text.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`));
  return m ? m[1] : "";
}
