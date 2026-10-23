// Makes the key that signs notifications (VAPID, an ECDSA P-256 key pair).
//   Production (the key goes straight into Cloudflare, never on screen):
//     node scripts/vapid.mjs | npx wrangler secret put VAPID_PRIVATE_JWK
//   Local development (appended to .dev.vars):
//     node scripts/vapid.mjs --dev
// Make it once. A new key means every parent turns notifications on again.
import { appendFileSync, readFileSync, existsSync } from "node:fs";
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", kp.privateKey);
const jwk = JSON.stringify({ kty, crv, x, y, d });
if (process.argv.includes("--dev")) {
  const file = new URL("../.dev.vars", import.meta.url);
  if (existsSync(file) && /^VAPID_PRIVATE_JWK=/m.test(readFileSync(file, "utf8"))) {
    console.error(".dev.vars already has VAPID_PRIVATE_JWK; leaving it as it is");
  } else {
    appendFileSync(file, `\n# Local only: signs notifications (made by scripts/vapid.mjs)\nVAPID_PRIVATE_JWK=${jwk}\n`);
    console.error("added VAPID_PRIVATE_JWK to .dev.vars");
  }
} else {
  process.stdout.write(jwk);
}
