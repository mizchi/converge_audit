import { describe, expect, it } from "vitest";
import { SerializedCommandQueue } from "../web/src/audit/serialized-command-queue";

describe("serialized command queue", () => {
  it("does not start the next state mutation before the current one settles", async () => {
    const queue = new SerializedCommandQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = queue.run(async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first:end");
      return 1;
    });
    const second = queue.run(async () => {
      events.push("second:start");
      return 2;
    });
    await Promise.resolve();

    expect(events).toEqual(["first:start"]);
    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("continues after one rejected mutation without hiding its error", async () => {
    const queue = new SerializedCommandQueue();
    const refused = queue.run(async () => {
      throw new Error("refused");
    });
    const accepted = queue.run(async () => "accepted");

    await expect(refused).rejects.toThrow("refused");
    await expect(accepted).resolves.toBe("accepted");
  });
});
