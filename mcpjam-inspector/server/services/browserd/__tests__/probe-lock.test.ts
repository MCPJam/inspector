import { describe, expect, it } from "vitest";
import { activeKeyedLockCount, withKeyedLock } from "../probe-lock";

/** A resolvable barrier. */
function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Flush all pending microtasks (a real macrotask turn). */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("withKeyedLock", () => {
  it("serializes work for the same key (no overlap)", async () => {
    const order: string[] = [];
    const a = defer();
    const b = defer();
    const p1 = withKeyedLock("s1", async () => {
      order.push("1-start");
      await a.promise;
      order.push("1-end");
    });
    const p2 = withKeyedLock("s1", async () => {
      order.push("2-start");
      await b.promise;
      order.push("2-end");
    });

    await flush();
    expect(order).toEqual(["1-start"]); // #2 blocked while #1 holds the key

    a.resolve();
    await flush();
    expect(order).toEqual(["1-start", "1-end", "2-start"]); // #2 only after #1 ended

    b.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["1-start", "1-end", "2-start", "2-end"]);
  });

  it("runs different keys concurrently", async () => {
    const order: string[] = [];
    const a = defer();
    const p1 = withKeyedLock("c-x", async () => {
      order.push("x-start");
      await a.promise;
    });
    const p2 = withKeyedLock("c-y", async () => {
      order.push("y-start");
    });
    await flush();
    expect(order).toEqual(["x-start", "y-start"]); // y did not wait on x
    a.resolve();
    await Promise.all([p1, p2]);
  });

  it("a failed run does not block the next on the same key", async () => {
    await expect(
      withKeyedLock("f1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const ran = await withKeyedLock("f1", async () => "ok");
    expect(ran).toBe("ok");
  });

  it("drains its key from the map once work completes", async () => {
    const before = activeKeyedLockCount();
    await withKeyedLock("d1", async () => "x");
    expect(activeKeyedLockCount()).toBe(before);
  });
});
