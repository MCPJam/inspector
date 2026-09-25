import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerCheckQueue } from "../server-check-queue";
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const options = (serverName: string) => ({
  projectId: "project",
  serverName,
  identity: "host",
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("server check scheduler", () => {
  it("runs 120 cards ten at a time in card order and reprioritizes pending work", async () => {
    const queue = new ServerCheckQueue();
    const names = Array.from({ length: 120 }, (_, i) => String(i));
    queue.setOrder("project", [...names].reverse());
    const starts: string[] = [];
    const releases = new Map<string, () => void>();
    const promises = names.map((name) =>
      queue.run(
        options(name),
        () =>
          new Promise<void>((resolve) => {
            starts.push(name);
            releases.set(name, resolve);
          }),
      ),
    );
    await tick();
    expect(starts).toEqual([...names].reverse().slice(0, 10));
    expect(queue.state("project", "0")).toBe("queued");
    queue.setOrder("project", names);
    releases.get("119")!();
    await tick();
    expect(starts.at(-1)).toBe("0");
    for (let i = 0; i < 120; i++) {
      for (const release of releases.values()) release();
      await tick();
    }
    await Promise.all(promises);
    expect(new Set(starts).size).toBe(120);
    expect(queue.state("project", "0")).toBeUndefined();
  });
  it("deduplicates mounts and cancels pending and active requests on scope changes", async () => {
    const queue = new ServerCheckQueue();
    queue.setScope("project", "a");
    const run = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    );
    const first = queue.run(options("one"), run);
    expect(queue.run(options("one"), run)).toBe(first);
    const rejected = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });
    await tick();
    queue.setScope("project", "b");
    await rejected;
    expect(run).toHaveBeenCalledOnce();
  });
  it("requeues only queue-specific 429s without holding a slot and respects Retry-After", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const queue = new ServerCheckQueue();
    const run = vi
      .fn()
      .mockRejectedValueOnce({
        status: 429,
        retryAfterMs: 3000,
        details: { reason: "SERVER_CHECK_QUEUE_FULL" },
      })
      .mockResolvedValue("ok");
    const result = queue.run(options("one"), run);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.state("project", "one")).toBe("queued");
    await vi.advanceTimersByTimeAsync(2999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    const other = queue.run(options("two"), async () => {
      throw { status: 429, details: { reason: "other" } };
    });
    const rejected = expect(other).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
  });
  it("stops queue retries after two minutes and offers a manual retry", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const queue = new ServerCheckQueue();
    const run = vi.fn(async () => {
      throw { status: 429, details: { reason: "SERVER_CHECK_QUEUE_TIMEOUT" } };
    });
    const result = queue.run(options("one"), run);
    const failure = expect(result).rejects.toThrow("Click Connect to retry");
    await vi.advanceTimersByTimeAsync(120_000);
    await failure;
    expect(run.mock.calls.length).toBeLessThanOrEqual(61);
    expect(queue.state("project", "one")).toBeUndefined();
  });

  it("does not hold a slot while sign-in awaits user input", async () => {
    const queue = new ServerCheckQueue();
    const jobs = Array.from({ length: 11 }, (_, i) =>
      queue.run(options(String(i)), async () => ({ oauthRequired: true })),
    );
    await expect(Promise.all(jobs)).resolves.toHaveLength(11);
    expect(queue.state("project", "10")).toBeUndefined();
  });

  it("does not retry a busy automatic check after auto-connect is disabled", async () => {
    const queue = new ServerCheckQueue();
    queue.markAutomatic("project", ["auto"]);
    let reject!: (error: unknown) => void;
    const result = queue.run(
      options("auto"),
      () =>
        new Promise((_resolve, rej) => {
          reject = rej;
        }),
    );
    const cancelled = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await tick();
    queue.setAutomaticEnabled("project", false);
    reject({ status: 429, details: { reason: "SERVER_CHECK_QUEUE_FULL" } });
    await cancelled;
    // A later explicit check of that same server is not an automatic retry.
    await expect(queue.run(options("auto"), async () => "ok")).resolves.toBe(
      "ok",
    );
  });

  it("clears undispatched automatic markers only for the disabled project", async () => {
    const queue = new ServerCheckQueue();
    queue.markAutomatic("project", ["manual"]);
    queue.markAutomatic("other", ["auto"]);
    queue.setAutomaticEnabled("project", false);
    await expect(queue.run(options("manual"), async () => "ok")).resolves.toBe("ok");
    const other = queue.run({ ...options("auto"), projectId: "other" }, async () => "unused");
    const cancelled = expect(other).rejects.toMatchObject({ name: "AbortError" });
    queue.cancelAutomatic("other");
    await cancelled;
  });

  it("cancels automatic waiting work without cancelling a manual check", async () => {
    const queue = new ServerCheckQueue();
    queue.markAutomatic("project", ["auto"]);
    const result = queue.run(options("auto"), async () => "unused");
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    queue.cancelAutomatic("project");
    await rejected;
    const manual = queue.run(options("manual"), async () => "ok");
    queue.cancelAutomatic("project");
    await expect(manual).resolves.toBe("ok");
  });
});
