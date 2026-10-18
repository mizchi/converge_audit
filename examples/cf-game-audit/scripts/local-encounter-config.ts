import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";

/** Development only: retain the same authority across local Worker restarts. */
export function ensureLocalEncounterConfig(path: string | URL): "created" | "existing" {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const seedExists = /^ENCOUNTER_SIGNING_SEED_HEX\s*=/m.test(text);
  const publicExists = /^ENCOUNTER_SIGNING_PUBLIC_KEY\s*=/m.test(text);
  if (seedExists !== publicExists) throw new Error("Incomplete local encounter key configuration; preserve and repair .dev.vars manually");
  if (seedExists) return "existing";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url").toString("hex");
  const key = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("hex");
  appendFileSync(path, `\n# Local development only. Keep across restarts. Never commit this file.\nENCOUNTER_SIGNING_SEED_HEX=${seed}\nENCOUNTER_SIGNING_PUBLIC_KEY=${key}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return "created";
}
