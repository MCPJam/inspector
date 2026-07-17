import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SURFACE_SNAPSHOT_CHARS,
  SURFACE_SNAPSHOT_TIMEOUT_MS,
  __resetSurfaceSnapshotProvidersForTests,
  hasSurfaceSnapshotProvider,
  listSurfaceSnapshotProviderIds,
  readAllSurfaceSnapshots,
  readSurfaceSnapshot,
  registerSurfaceSnapshotProvider,
} from "../surface-snapshot-registry";

afterEach(() => {
  __resetSurfaceSnapshotProvidersForTests();
  vi.useRealTimers();
});

describe("registerSurfaceSnapshotProvider", () => {
  it("registers, reads back, and disposes", () => {
    const dispose = registerSurfaceSnapshotProvider("playground", () => ({
      a: 1,
    }));
    expect(hasSurfaceSnapshotProvider("playground")).toBe(true);
    dispose();
    expect(hasSurfaceSnapshotProvider("playground")).toBe(false);
  });

  it("replaces a re-registered surface instead of throwing (HMR/StrictMode)", async () => {
    registerSurfaceSnapshotProvider("playground", () => ({ gen: 1 }));
    registerSurfaceSnapshotProvider("playground", () => ({ gen: 2 }));
    await expect(readSurfaceSnapshot("playground")).resolves.toEqual({
      ok: true,
      data: { gen: 2 },
    });
  });

  it("a stale disposer does not drop the live provider", async () => {
    // StrictMode can register the replacement BEFORE the first effect's
    // cleanup runs; a blind delete there would leave the surface silently
    // unobservable.
    const disposeFirst = registerSurfaceSnapshotProvider("playground", () => ({
      gen: 1,
    }));
    registerSurfaceSnapshotProvider("playground", () => ({ gen: 2 }));
    disposeFirst();
    expect(hasSurfaceSnapshotProvider("playground")).toBe(true);
    await expect(readSurfaceSnapshot("playground")).resolves.toEqual({
      ok: true,
      data: { gen: 2 },
    });
  });
});

describe("readSurfaceSnapshot", () => {
  it("errors for an unregistered surface", async () => {
    const result = await readSurfaceSnapshot("evals");
    expect(result).toEqual({
      ok: false,
      error: 'No snapshot provider for "evals".',
    });
  });

  it("isolates a throwing provider", async () => {
    registerSurfaceSnapshotProvider("playground", () => {
      throw new Error("store exploded");
    });
    expect(await readSurfaceSnapshot("playground")).toEqual({
      ok: false,
      error: "store exploded",
    });
  });

  it("resolves async providers", async () => {
    registerSurfaceSnapshotProvider("playground", async () => ({ ok: 1 }));
    expect(await readSurfaceSnapshot("playground")).toEqual({
      ok: true,
      data: { ok: 1 },
    });
  });

  it("times out a hanging provider instead of hanging the snapshot", async () => {
    vi.useFakeTimers();
    registerSurfaceSnapshotProvider("playground", () => new Promise(() => {}));
    const pending = readSurfaceSnapshot("playground");
    await vi.advanceTimersByTimeAsync(SURFACE_SNAPSHOT_TIMEOUT_MS + 1);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("timed out");
  });

  it("truncates an oversize snapshot rather than blowing the context", async () => {
    registerSurfaceSnapshotProvider("playground", () => ({
      blob: "x".repeat(MAX_SURFACE_SNAPSHOT_CHARS * 2),
    }));
    const result = await readSurfaceSnapshot("playground");
    expect(result.ok).toBe(true);
    expect((result as { data: any }).data.truncated).toBe(true);
  });

  it("does not throw when a provider returns undefined", async () => {
    // JSON.stringify(undefined) is `undefined`, not a string — reading
    // `.length` off it would crash the whole-app snapshot.
    registerSurfaceSnapshotProvider("playground", () => undefined);
    const result = await readSurfaceSnapshot("playground");
    expect(result).toEqual({ ok: true, data: { empty: true } });
  });

  it("reports an unserializable snapshot instead of throwing", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    registerSurfaceSnapshotProvider("playground", () => circular);
    const result = await readSurfaceSnapshot("playground");
    expect(result.ok).toBe(true);
    expect((result as { data: any }).data.error).toContain(
      "not JSON-serializable",
    );
  });
});

describe("readAllSurfaceSnapshots", () => {
  it("reads every mounted surface in sorted id order", async () => {
    registerSurfaceSnapshotProvider("playground", () => ({ p: 1 }));
    registerSurfaceSnapshotProvider("evals", () => ({ e: 1 }));
    expect(listSurfaceSnapshotProviderIds()).toEqual(["evals", "playground"]);
    expect(Object.keys(await readAllSurfaceSnapshots())).toEqual([
      "evals",
      "playground",
    ]);
  });

  it("one broken surface does not take down the rest", async () => {
    registerSurfaceSnapshotProvider("playground", () => ({ p: 1 }));
    registerSurfaceSnapshotProvider("evals", () => {
      throw new Error("nope");
    });
    expect(await readAllSurfaceSnapshots()).toEqual({
      evals: { error: "nope" },
      playground: { p: 1 },
    });
  });

  it("is empty when nothing is mounted", async () => {
    expect(await readAllSurfaceSnapshots()).toEqual({});
  });

  it("reads providers concurrently, so one slow surface doesn't delay the rest", async () => {
    // Serial reads would cost N×timeout with N hanging surfaces while a chat
    // stream waits. Two providers that each resolve on a timer must finish in
    // ~one delay, not two.
    vi.useFakeTimers();
    const slow = (ms: number, value: unknown) => () =>
      new Promise((resolve) => setTimeout(() => resolve(value), ms));
    registerSurfaceSnapshotProvider("playground", slow(1000, { p: 1 }));
    registerSurfaceSnapshotProvider("evals", slow(1000, { e: 1 }));

    const pending = readAllSurfaceSnapshots();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ playground: { p: 1 }, evals: { e: 1 } });
  });
});
