import { isTime } from "./wire.ts";
type WorkerModule = typeof import("../../../../_build/js/release/build/x/game_audit/worker/worker.js");
let workerModule: Promise<WorkerModule> | undefined;
// This generated package also initializes its random module. Worker permits
// that initialization inside a handler, never during global module evaluation.
const load = () => workerModule ??= import("../../../../_build/js/release/build/x/game_audit/worker/worker.js");

/** Preserve the ordering of checked JS safe-integer clocks using 0/1. Absolute
UNIX milliseconds never get narrowed to MoonBit Int or wrapped modulo 2^32. */
export async function terminationAllowed(settled: boolean, alreadyTerminated: boolean, expiry: boolean,
  hasCommitment: boolean, now: number, deadline: number): Promise<boolean> {
  if (![settled, alreadyTerminated, expiry, hasCommitment].every((v) => typeof v === "boolean") ||
      !isTime(now) || !isTime(deadline)) return false;
  return (await load()).audit_encounter_termination_allowed(settled, alreadyTerminated, expiry, hasCommitment,
    now >= deadline ? 1 : 0, 1);
}
export async function terminalCleanupAllowed(terminated: boolean, now: number, retentionUntil: number,
  held: boolean): Promise<boolean> {
  if (typeof terminated !== "boolean" || typeof held !== "boolean" || !isTime(now) || !isTime(retentionUntil)) return false;
  return (await load()).audit_encounter_terminal_cleanup_allowed(terminated, now >= retentionUntil ? 1 : 0, 1, held);
}
