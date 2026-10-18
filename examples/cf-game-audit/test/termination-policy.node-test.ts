import assert from "node:assert/strict";
import test from "node:test";
import { terminationAllowed, terminalCleanupAllowed } from "../game/encounter/termination-policy.ts";

test("UNIX and safe-integer clock boundaries reach the MoonBit guard without Int narrowing", async () => {
  for (const deadline of [2 ** 31 + 9, 2 ** 32 + 11, 1_800_000_000_000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(await terminationAllowed(false, false, true, false, deadline - 1, deadline), false);
    assert.equal(await terminationAllowed(false, false, true, false, deadline, deadline), true);
    assert.equal(await terminalCleanupAllowed(true, deadline - 1, deadline, false), false);
    assert.equal(await terminalCleanupAllowed(true, deadline, deadline, false), true);
    assert.equal(await terminalCleanupAllowed(true, deadline, deadline, true), false);
  }
});
test("invalid clocks and terminal-state conflicts fail closed before calling an Int gate", async () => {
  for (const bad of [-1, Number.NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await terminationAllowed(false, true, false, false, bad, 0), false);
    assert.equal(await terminationAllowed(false, true, false, false, 0, bad), false);
    assert.equal(await terminalCleanupAllowed(true, bad, 0, false), false);
    assert.equal(await terminalCleanupAllowed(true, 0, bad, false), false);
  }
  assert.equal(await terminationAllowed(true, true, false, false, 1, 0), false);
  assert.equal(await terminationAllowed(false, true, true, true, 0, 1), true);
});
