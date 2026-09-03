import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { messageOf, useOrgScopedWrite } from "../useOrgScopedWrite";

/**
 * The three things this hook exists to get right, each of which is only
 * visible in a race.
 */

/** A promise plus the handles to settle it later. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("messageOf", () => {
  it("prefers a ConvexError's structured payload over the redacted message", () => {
    // In production Convex rewrites a thrown Error's message to "Server
    // Error"; the payload is the only place the real sentence survives, so
    // reading `.message` first showed every deliberate refusal as a generic
    // failure.
    const error = Object.assign(new Error("[CONVEX M(x)] Server Error"), {
      data: {
        message: "Resume and enable the destination before backfilling.",
      },
    });
    expect(messageOf(error)).toBe(
      "Resume and enable the destination before backfilling.",
    );
  });

  it("accepts a bare string payload too", () => {
    const error = Object.assign(new Error("Server Error"), {
      data: "That channel is already bound.",
    });
    expect(messageOf(error)).toBe("That channel is already bound.");
  });

  it("strips every bracketed prefix, not just the first", () => {
    // Convex can put the operation name and the request id on one line.
    const error = new Error(
      "at handler\n[CONVEX M(traceDestinations:startBackfill)] [Request ID: abc123] Nothing to backfill.",
    );
    expect(messageOf(error)).toBe("Nothing to backfill.");
  });

  it("falls back to the raw message rather than an empty string", () => {
    expect(messageOf(new Error("[only a prefix]"))).toBe("[only a prefix]");
  });
});

describe("useOrgScopedWrite", () => {
  it("reports a failure for the org that is still on screen", async () => {
    const { result } = renderHook(() => useOrgScopedWrite("org-a"));
    await act(async () => {
      await result.current
        .run(async () => {
          throw new Error("nope");
        })
        .catch(() => {});
    });
    expect(result.current.error).toBe("nope");
    expect(result.current.isSaving).toBe(false);
  });

  it("drops a completion that lands after the org changed", async () => {
    // The org picker is one click away and a mutation is a round trip. A
    // failure from the org you just left must not appear on the one you are
    // now looking at.
    const pending = deferred();
    const { result, rerender } = renderHook(
      ({ org }: { org: string }) => useOrgScopedWrite(org),
      { initialProps: { org: "org-a" } },
    );

    let settled: Promise<void>;
    act(() => {
      settled = result.current.run(() => pending.promise).catch(() => {});
    });
    expect(result.current.isSaving).toBe(true);

    rerender({ org: "org-b" });
    await act(async () => {
      pending.reject(new Error("org A said no"));
      await settled;
    });

    expect(result.current.error).toBeNull();
    expect(result.current.isSaving).toBe(false);
  });

  it("lets only the NEWEST write of the same org report", async () => {
    // The org id alone cannot separate these: both writes belong to org-a.
    // Without a generation, the first to finish clears `isSaving` while the
    // second is still running, and its failure overwrites the second's error.
    const first = deferred();
    const second = deferred();
    const { result } = renderHook(() => useOrgScopedWrite("org-a"));

    let firstSettled: Promise<void>;
    let secondSettled: Promise<void>;
    act(() => {
      firstSettled = result.current.run(() => first.promise).catch(() => {});
    });
    act(() => {
      secondSettled = result.current.run(() => second.promise).catch(() => {});
    });

    // The EARLIER write finishes first, and must not touch the state.
    await act(async () => {
      first.reject(new Error("stale failure"));
      await firstSettled;
    });
    expect(result.current.error).toBeNull();
    expect(result.current.isSaving).toBe(true);

    await act(async () => {
      second.resolve();
      await secondSettled;
    });
    await waitFor(() => expect(result.current.isSaving).toBe(false));
    expect(result.current.error).toBeNull();
  });
});
