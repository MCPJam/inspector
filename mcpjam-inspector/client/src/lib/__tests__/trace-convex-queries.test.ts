import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
vi.mock("../error-reporting", () => ({ reportCaught: vi.fn() }));
import { reportCaught } from "../error-reporting";
import { traceConvexQueries } from "../trace-convex-queries";

const query = makeFunctionReference<"query">("scenarios:listScenarios");
const failure = new Error(
  "[CONVEX Q(scenarios:listScenarios)] [Request ID: abc123] Server Error",
);
function fixture() {
  let error: unknown;
  let result: unknown;
  const callbacks = new Set<() => void>();
  const unsubscribe = vi.fn();
  const watch = {
    localQueryResult: vi.fn(() => {
      if (error) throw error;
      return result;
    }),
    onUpdate: vi.fn((cb: () => void) => {
      callbacks.add(cb);
      return () => {
        callbacks.delete(cb);
        unsubscribe();
      };
    }),
    localQueryLogs: vi.fn(() => []),
    journal: vi.fn(() => undefined),
  };
  const original = vi.fn(() => watch);
  const client = { watchQuery: original } as unknown as ConvexReactClient;
  traceConvexQueries(client, "https://test.convex.cloud");
  return {
    client,
    original,
    watch,
    unsubscribe,
    set: (next: unknown, err?: unknown) => {
      result = next;
      error = err;
    },
    update: () => callbacks.forEach((cb) => cb()),
  };
}
describe("traced watches", () => {
  beforeEach(() => {
    vi.mocked(reportCaught).mockReset();
  });
  it("preserves args, options, results, other watch methods and cleanup", () => {
    const f = fixture();
    const args = { projectId: "do-not-log" };
    const options = {};
    const watch = f.client.watchQuery(query, args, options);
    expect(f.original).toHaveBeenCalledExactlyOnceWith(query, args, options);
    expect(watch.localQueryResult()).toBeUndefined();
    expect(watch.localQueryLogs).toBe(f.watch.localQueryLogs);
    expect(watch.journal).toBe(f.watch.journal);
    const cb = vi.fn();
    const stop = watch.onUpdate(cb);
    f.set([1]);
    f.update();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(watch.localQueryResult()).toEqual([1]);
    expect(reportCaught).not.toHaveBeenCalled();
    stop();
    f.update();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(f.original).toHaveBeenCalledTimes(1);
  });
  it("reports failures even when the consumer never reads them", () => {
    const f = fixture();
    const cb = vi.fn();
    f.client.watchQuery(query, {}).onUpdate(cb);
    f.set(undefined, failure);
    f.update();
    expect(reportCaught).toHaveBeenCalledWith(
      expect.objectContaining({ message: failure.message }),
      {
        source: "convex_query_subscription",
        queryBackend: "test.convex.cloud",
      },
    );
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it("reports a cached failure on subscription and preserves thrown error identity", () => {
    const f = fixture();
    f.set(undefined, failure);
    const watch = f.client.watchQuery(query, {});
    watch.onUpdate(() => {});
    expect(reportCaught).toHaveBeenCalledTimes(1);
    expect(() => watch.localQueryResult()).toThrow(failure);
    try {
      watch.localQueryResult();
    } catch (e) {
      expect(e).toBe(failure);
    }
  });
  it("deduplicates ID-less failures per watch until a successful read", () => {
    const f = fixture();
    const noId = new Error("[CONVEX Q(scenarios:listScenarios)] Server Error");
    f.set(undefined, noId);
    const watch = f.client.watchQuery(query, {});
    watch.onUpdate(() => {});
    f.update();
    expect(() => watch.localQueryResult()).toThrow(noId);
    expect(reportCaught).toHaveBeenCalledTimes(1);
    // Other watches report independently even when the safe message matches.
    f.client.watchQuery(query, {}).onUpdate(() => {});
    expect(reportCaught).toHaveBeenCalledTimes(2);
    f.set([]);
    expect(watch.localQueryResult()).toEqual([]);
    f.set(undefined, noId);
    expect(() => watch.localQueryResult()).toThrow(noId);
    expect(reportCaught).toHaveBeenCalledTimes(3);
  });
  it("resets after a successful update and reports changed request IDs", () => {
    const f = fixture();
    f.set(undefined, failure);
    f.client.watchQuery(query, {}).onUpdate(() => {});
    f.update();
    expect(reportCaught).toHaveBeenCalledTimes(1);
    f.set(undefined, new Error(failure.message.replace("abc123", "def456")));
    f.update();
    expect(reportCaught).toHaveBeenCalledTimes(2);
    f.set([]);
    f.update();
    f.set(undefined, failure);
    f.update();
    expect(reportCaught).toHaveBeenCalledTimes(3);
  });
  it("does not report authorization refusals", () => {
    const f = fixture();
    const refused = new ConvexError({ kind: "forbidden" });
    f.set(undefined, refused);
    const watch = f.client.watchQuery(query, {});
    watch.onUpdate(() => {});
    expect(() => watch.localQueryResult()).toThrow();
    expect(reportCaught).not.toHaveBeenCalled();
  });
  it("isolates reporting failures without swallowing consumer exceptions", () => {
    const f = fixture();
    f.set(undefined, failure);
    vi.mocked(reportCaught).mockImplementation(() => {
      throw new Error("telemetry down");
    });
    const watch = f.client.watchQuery(query, {});
    const consumerError = new Error("consumer");
    expect(() =>
      watch.onUpdate(() => {
        throw consumerError;
      }),
    ).not.toThrow();
    expect(() => f.update()).toThrow(consumerError);
    expect(() => watch.localQueryResult()).toThrow(failure);
  });
  it("installs once and does not leak validation arguments", () => {
    const f = fixture();
    traceConvexQueries(f.client, "https://test.convex.cloud");
    f.set(undefined, new Error("Validation failed: SECRET"));
    f.client.watchQuery(query, { token: "SECRET" }).onUpdate(() => {});
    expect(reportCaught).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportCaught).mock.calls[0][0]).toMatchObject({
      message: "[CONVEX Q(scenarios:listScenarios)] Query failed",
    });
  });
});
