/**
 * Serializes state-owning asynchronous commands while preserving each
 * command's result. A rejection is returned to its caller but does not poison
 * later commands.
 */
export class SerializedCommandQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(command: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(command);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
