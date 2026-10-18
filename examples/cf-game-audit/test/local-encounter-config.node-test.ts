import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalEncounterConfig } from "../scripts/local-encounter-config.ts";

test("development authority keys persist across restarts and preserve unrelated settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "encounter-config-")); const path = join(directory, ".dev.vars");
  try {
    writeFileSync(path, "UNRELATED=value\n");
    assert.equal(ensureLocalEncounterConfig(path), "created");
    const first = readFileSync(path, "utf8");
    assert.match(first, /^UNRELATED=value$/m);
    assert.match(first, /^ENCOUNTER_SIGNING_SEED_HEX=[0-9a-f]{64}$/m);
    assert.match(first, /^ENCOUNTER_SIGNING_PUBLIC_KEY=[0-9a-f]{64}$/m);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(ensureLocalEncounterConfig(path), "existing");
    assert.equal(readFileSync(path, "utf8"), first);
  } finally { rmSync(directory, { recursive: true }); }
});
test("an incomplete development key pair is refused without replacing retained key material", () => {
  const directory = mkdtempSync(join(tmpdir(), "encounter-config-")); const path = join(directory, ".dev.vars");
  try {
    const original = `ENCOUNTER_SIGNING_SEED_HEX=${"a".repeat(64)}\n`; writeFileSync(path, original);
    assert.throws(() => ensureLocalEncounterConfig(path), /Incomplete/);
    assert.equal(readFileSync(path, "utf8"), original);
  } finally { rmSync(directory, { recursive: true }); }
});
