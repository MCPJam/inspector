import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  loadEvalToolMetadata,
  readEvalToolMetadata,
  useEvalToolMetadata,
} from "../eval-tool-metadata";
const target = {
  projectId: "p",
  environmentKey: "v1",
  serverIds: ["fast", "slow"],
};
beforeEach(() => useEvalToolMetadata.setState({ entries: {} }));
// A failed assertion must not leave fake timers running into the next test.
afterEach(() => {
  vi.useRealTimers();
});
it("publishes each server immediately and retains successes when another fails", async () => {
  let finish!: (value: { tools: { name: string }[] }) => void;
  const load = vi.fn((id: string) =>
    id === "fast"
      ? Promise.resolve({ tools: [{ name: "search" }] })
      : new Promise<{ tools: { name: string }[] }>((resolve) => {
          finish = resolve;
        }),
  );
  const pending = loadEvalToolMetadata(target, load);
  await vi.waitFor(() =>
    expect(readEvalToolMetadata(target).tools).toHaveLength(1),
  );
  expect(readEvalToolMetadata(target).servers[1].status).toBe("loading");
  finish({ tools: [] });
  await pending;
  expect(readEvalToolMetadata(target).servers[1].status).toBe("empty");
  await loadEvalToolMetadata(
    target,
    async (id) => {
      if (id === "slow")
        throw Object.assign(new Error("Unauthorized"), { status: 401 });
      return { tools: [{ name: "search" }] };
    },
    true,
  );
  expect(readEvalToolMetadata(target).tools).toHaveLength(1);
  expect(readEvalToolMetadata(target).servers[1]).toMatchObject({
    status: "error",
    action: "reconnect",
  });
});
it("deduplicates requests, reuses fresh metadata, and isolates environment changes", async () => {
  const load = vi.fn(async () => ({ tools: [{ name: "search" }] }));
  await Promise.all([
    loadEvalToolMetadata(target, load),
    loadEvalToolMetadata(target, load),
  ]);
  await loadEvalToolMetadata(target, load);
  expect(load).toHaveBeenCalledTimes(2);
  await loadEvalToolMetadata({ ...target, environmentKey: "v2" }, load);
  expect(load).toHaveBeenCalledTimes(4);
});
it("retries transient errors once without treating failure as an empty catalogue", async () => {
  vi.useFakeTimers();
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error("Network error"))
    .mockResolvedValue({ tools: [{ name: "search" }] });
  const pending = loadEvalToolMetadata(
    { ...target, serverIds: ["fast"] },
    load,
  );
  await vi.runAllTimersAsync();
  await pending;
  expect(load).toHaveBeenCalledTimes(2);
  expect(readEvalToolMetadata(target).servers[0].status).toBe("ready");
  vi.useRealTimers();
});
it("keeps the last catalogue while a stale entry revalidates and when it fails", async () => {
  vi.useFakeTimers();
  const single = { ...target, serverIds: ["fast"] };
  await loadEvalToolMetadata(single, async () => ({
    tools: [{ name: "search" }],
  }));
  vi.advanceTimersByTime(61_000);
  let fail!: (error: Error) => void;
  const request = loadEvalToolMetadata(
    single,
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  expect(readEvalToolMetadata(single).servers[0]).toMatchObject({
    status: "loading",
    tools: [{ name: "search" }],
  });
  fail(Object.assign(new Error("Unauthorized"), { status: 401 }));
  await request;
  expect(readEvalToolMetadata(single).servers[0]).toMatchObject({
    status: "error",
    action: "reconnect",
    tools: [{ name: "search" }],
  });
  vi.useRealTimers();
});
it("retries a failed catalogue on the next load instead of serving the failure", async () => {
  const single = { ...target, serverIds: ["fast"] };
  const load = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    )
    .mockResolvedValue({ tools: [{ name: "search" }] });
  await loadEvalToolMetadata(single, load);
  expect(readEvalToolMetadata(single).servers[0].status).toBe("error");
  await loadEvalToolMetadata(single, load);
  expect(load).toHaveBeenCalledTimes(2);
  expect(readEvalToolMetadata(single).servers[0].status).toBe("ready");
});
it("bounds hung requests and exposes retry without waiting forever", async () => {
  vi.useFakeTimers();
  const load = vi.fn(() => new Promise<{}>(() => {}));
  const request = loadEvalToolMetadata(
    { ...target, serverIds: ["fast"] },
    load,
  );
  await vi.advanceTimersByTimeAsync(25_000);
  expect(readEvalToolMetadata(target).servers[0]).toMatchObject({
    status: "error",
    action: "retry",
  });
  await request;
  expect(load).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
