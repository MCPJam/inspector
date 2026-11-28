import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSingleFlight } from "../use-single-flight";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useSingleFlight", () => {
  it("refuses a second run while the first is still pending", async () => {
    const { result } = renderHook(() => useSingleFlight());
    const gate = deferred();
    const second = vi.fn(async () => "second");

    let first!: Promise<string | undefined>;
    act(() => {
      first = result.current.run(async () => {
        await gate.promise;
        return "first";
      });
    });
    let refused!: Promise<string | undefined>;
    act(() => {
      refused = result.current.run(second);
    });

    expect(await refused).toBeUndefined();
    expect(second).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(true);

    await act(async () => gate.resolve());
    expect(await first).toBe("first");
    expect(result.current.pending).toBe(false);
  });

  it("runs again once the previous task resolved", async () => {
    const { result } = renderHook(() => useSingleFlight());
    await act(async () => {
      await result.current.run(async () => undefined);
    });
    const next = vi.fn(async () => "again");

    let value: string | undefined;
    await act(async () => {
      value = await result.current.run(next);
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(value).toBe("again");
  });

  it("releases after a task throws, and passes the error on", async () => {
    const { result } = renderHook(() => useSingleFlight());

    await act(async () => {
      await expect(
        result.current.run(async () => {
          throw new Error("preparation failed");
        }),
      ).rejects.toThrow("preparation failed");
    });

    expect(result.current.pending).toBe(false);
    const next = vi.fn(async () => true);
    await act(async () => {
      await result.current.run(next);
    });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
