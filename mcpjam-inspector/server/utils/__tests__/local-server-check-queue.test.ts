import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalServerCheckQueue } from "../local-server-check-queue.js";
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const args = (key: string, automatic = false, owner = "session") => ({
  owner,
  requestId: key,
  key,
  intent: automatic ? ("automatic" as const) : ("manual" as const),
  signal: new AbortController().signal,
});
function harness() {
  const queue = new LocalServerCheckQueue();
  const starts: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const releases = new Map<string, () => void>();
  const outcomes: Promise<unknown>[] = [];
  const submit = (key: string, automatic = false, overrides = {}) => {
    const promise = queue.run(
      { ...args(key, automatic), ...overrides },
      (signal) =>
        new Promise<void>((resolve) => {
          starts.push(key);
          signals.set(key, signal);
          releases.set(key, resolve);
        }),
    );
    outcomes.push(promise.catch((error) => error));
    return promise;
  };
  const finish = async () => {
    for (let i = 0; i < 130; i++) {
      for (const release of releases.values()) release();
      await tick();
    }
    await queue.shutdown();
    return Promise.all(outcomes);
  };
  return { queue, starts, signals, releases, submit, finish };
}
afterEach(() => vi.useRealTimers());
describe("local process connection admission", () => {
  it("shares ten slots across tabs, projects and owners; established connections leave the queue", async () => {
    const h = harness();
    for (let i = 0; i < 12; i++)
      h.submit(String(i), false, { owner: i % 2 ? "tab-a" : "tab-b" });
    await tick();
    expect(h.starts).toHaveLength(10);
    h.releases.get("0")!();
    await tick();
    expect(h.starts.at(-1)).toBe("10");
    await h.finish();
    expect(h.starts).toHaveLength(12);
    expect(h.signals.get("0")!.aborted).toBe(false);
  });
  it("interrupts exactly one newest automatic attempt and waits for cleanup", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.submit(String(i), true);
    await tick();
    const manual = h.submit("manual");
    await tick();
    expect([...h.signals.values()].filter((s) => s.aborted)).toHaveLength(1);
    expect(h.signals.get("9")!.reason.reason).toBe("SERVER_CHECK_PREEMPTED");
    expect(h.starts).toHaveLength(10);
    h.queue.promote("session", "manual");
    h.queue.promote("session", "manual");
    expect([...h.signals.values()].filter((s) => s.aborted)).toHaveLength(1);
    h.releases.get("9")!();
    await tick();
    expect(h.starts.at(-1)).toBe("manual");
    h.releases.get("manual")!();
    await manual;
    await h.finish();
  });
  it("serves manual click order before automatic FIFO and protects promoted active attempts", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.submit(String(i), true);
    await tick();
    h.queue.promote("session", "9");
    h.submit("auto", true);
    h.submit("second-auto", true);
    h.submit("first-click");
    h.submit("second-click");
    await tick();
    expect(h.signals.get("9")!.aborted).toBe(false);
    expect([...h.signals.values()].filter((s) => s.aborted)).toHaveLength(2);
    h.releases.get("8")!();
    await tick();
    expect(h.starts.at(-1)).toBe("first-click");
    h.releases.get("7")!();
    await tick();
    expect(h.starts.at(-1)).toBe("second-click");
    h.releases.get("first-click")!();
    await tick();
    expect(h.starts.at(-1)).toBe("auto");
    await h.finish();
  });
  it("never interrupts manual work and serializes the same runtime key", async () => {
    const h = harness();
    h.submit("original");
    await tick();
    h.submit("same-server", false, { key: "original" });
    for (let i = 0; i < 10; i++) h.submit(String(i));
    await tick();
    expect(h.starts).toHaveLength(10);
    expect(h.starts).not.toContain("same-server");
    expect([...h.signals.values()].some((s) => s.aborted)).toBe(false);
    h.releases.get("original")!();
    await tick();
    expect(h.starts.at(-1)).toBe("same-server");
    await h.finish();
  });
  it("does not over-interrupt when two manual waiters target the same automatic key", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.submit(String(i), true);
    await tick();
    h.submit("replace-0", false, { key: "0" });
    h.submit("manual");
    h.submit("also-replace-0", false, { key: "0" });
    await tick();
    expect([...h.signals.values()].filter((s) => s.aborted)).toHaveLength(2);
    await h.finish();
  });
  it("bounds waiting at 100 and replaces only the newest waiting automatic for manual work", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.submit(String(i));
    for (let i = 0; i < 100; i++) h.submit(`pending-${i}`, true);
    await expect(h.submit("overflow", true)).rejects.toMatchObject({
      status: 429,
      reason: "SERVER_CHECK_QUEUE_FULL",
    });
    h.submit("click");
    expect(h.queue.promote("session", "pending-99").state).toBe("expired");
    expect(h.queue.promote("session", "pending-98").state).toBe("waiting");
    h.releases.get("0")!();
    await tick();
    expect(h.starts.at(-1)).toBe("click");
    await h.finish();
  });
  it("refuses a full manual queue; expires waiting entries at thirty seconds", async () => {
    vi.useFakeTimers();
    const h = harness();
    for (let i = 0; i < 110; i++) h.submit(String(i));
    await tick();
    await expect(h.submit("overflow")).rejects.toMatchObject({
      reason: "SERVER_CHECK_QUEUE_FULL",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.queue.promote("session", "10").state).toBe("expired");
    expect(h.starts).toHaveLength(10);
    const results = await h.finish();
    expect(results).toContainEqual(
      expect.objectContaining({ reason: "SERVER_CHECK_QUEUE_TIMEOUT" }),
    );
  });
  it("deduplicates IDs, isolates promotion ownership and cancels pending and active work", async () => {
    const h = harness();
    const controller = new AbortController();
    const first = h.submit("same", true, { signal: controller.signal });
    await tick();
    const duplicate = h.queue.run(args("same", true), async () => {
      throw new Error("duplicate");
    });
    expect(duplicate).toBe(first);
    expect(h.queue.promote("different-session", "same").state).toBe("expired");
    const waitingAbort = new AbortController();
    const waiting = h.submit("waiting", true, {
      key: "same",
      signal: waitingAbort.signal,
    });
    waitingAbort.abort();
    await expect(waiting).rejects.toHaveProperty("name", "AbortError");
    controller.abort();
    await tick();
    expect(h.signals.get("same")!.aborted).toBe(true);
    h.releases.get("same")!();
    await expect(first).rejects.toHaveProperty("name", "AbortError");
    await h.finish();
    await expect(
      h.queue.run(args("after-shutdown"), async () => {}),
    ).rejects.toMatchObject({ status: 503 });
  });
});
