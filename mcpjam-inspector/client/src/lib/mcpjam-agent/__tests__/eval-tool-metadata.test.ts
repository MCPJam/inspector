import { beforeEach, expect, it, vi } from "vitest";
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
