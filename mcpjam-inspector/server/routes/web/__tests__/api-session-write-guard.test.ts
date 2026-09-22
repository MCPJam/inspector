import { expect, it, vi } from "vitest";
import { apiSessionWriteAllowed } from "../api-session-write-guard";
it("never adds a backend request to ordinary Playground sends", async () => {
  const read = vi.fn();
  expect(await apiSessionWriteAllowed(undefined, read)).toBe(true);
  expect(await apiSessionWriteAllowed("playground", read)).toBe(true);
  expect(read).not.toHaveBeenCalled();
});
it("rejects a confirmed restored API origin but tolerates transport failure", async () => {
  expect(
    await apiSessionWriteAllowed("api", async () => ({ writable: false })),
  ).toBe(false);
  expect(
    await apiSessionWriteAllowed("api", async () => {
      throw new Error("unavailable");
    }),
  ).toBe(true);
});

it("bounds a stalled advisory read and aborts its request", async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    const result = apiSessionWriteAllowed("api", (value) => {
      signal = value;
      return new Promise(() => {});
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
