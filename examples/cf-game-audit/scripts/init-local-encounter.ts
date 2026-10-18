import { ensureLocalEncounterConfig } from "./local-encounter-config.ts";
if (ensureLocalEncounterConfig(new URL("../.dev.vars", import.meta.url)) === "created") {
  console.log("Local encounter signing key saved to ignored .dev.vars (private material is not printed)");
} else console.log("Using the existing local encounter signing key");
