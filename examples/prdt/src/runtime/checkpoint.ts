import type { JsonValue } from "../core/canonical.ts";

/**
 * Durable snapshot storage. A replica must persist its own proposals and (for
 * an authority) its own certificates before disseminating them; otherwise a
 * restart could reuse a command id for a different payload or close a tick
 * twice, which the protocol correctly refuses as a conflict.
 */
export interface CheckpointStore {
  load(): JsonValue | undefined;
  save(snapshot: JsonValue): void;
}

export class InMemoryCheckpointStore implements CheckpointStore {
  #snapshot: string | undefined;

  load(): JsonValue | undefined {
    return this.#snapshot === undefined ? undefined : (JSON.parse(this.#snapshot) as JsonValue);
  }

  save(snapshot: JsonValue): void {
    this.#snapshot = JSON.stringify(snapshot);
  }
}
