import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StartPluginImportResult } from "@/lib/plugins/plugin-import-client";

const { mockStartFromZip } = vi.hoisted(() => ({
  mockStartFromZip: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvex: () => ({}),
  useQuery: () => undefined,
}));

vi.mock("@/lib/plugins/plugin-import-client", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/plugins/plugin-import-client")>();
  return { ...actual, startPluginImportFromZip: mockStartFromZip };
});

import { usePluginImportRunner } from "../usePluginImport";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const okResult = (importId: string): StartPluginImportResult => ({
  importId,
  bundleStorageId: "st",
  inspect: { importId, status: "preview_ready" },
});

describe("usePluginImportRunner", () => {
  beforeEach(() => mockStartFromZip.mockReset());

  it("advances uploading → inspecting → done and exposes importId", async () => {
    const d = deferred<StartPluginImportResult>();
    mockStartFromZip.mockReturnValue(d.promise);

    const { result } = renderHook(() => usePluginImportRunner());
    let call!: Promise<StartPluginImportResult>;
    act(() => {
      call = result.current.startFromZip({
        projectId: "p",
        bundle: new Blob([]),
      });
    });
    expect(result.current.phase).toBe("uploading");

    // The runner threads an onPhase callback into the orchestrator; driving it
    // moves the runner into the (otherwise unobservable) inspecting phase AND
    // must expose the staged importId so usePluginImport(importId) can subscribe
    // to server-side progress while inspection runs (not null until done).
    const onPhase = mockStartFromZip.mock.calls[0][1].onPhase as (
      p: "uploading" | "inspecting",
      importId?: string,
    ) => void;
    expect(typeof onPhase).toBe("function");
    act(() => onPhase("inspecting", "i1"));
    expect(result.current.phase).toBe("inspecting");
    expect(result.current.importId).toBe("i1");

    await act(async () => {
      d.resolve(okResult("i1"));
      await call;
    });
    expect(result.current.phase).toBe("done");
    expect(result.current.importId).toBe("i1");
  });

  it("moves to the error phase (with importId) on a failed inspect", async () => {
    // A failed inspect resolves (does not throw); the runner records the error
    // phase AND keeps the importId so the UI can still surface the row.
    // (The throw-path importId preservation is covered in plugin-import-client
    // via PluginImportError.importId.)
    mockStartFromZip.mockResolvedValue({
      importId: "i_failed",
      bundleStorageId: "st",
      inspect: { importId: "i_failed", status: "failed", failureCode: "X" },
    });
    const { result } = renderHook(() => usePluginImportRunner());
    await act(async () => {
      await result.current.startFromZip({
        projectId: "p",
        bundle: new Blob([]),
      });
    });
    expect(result.current.phase).toBe("error");
    expect(result.current.importId).toBe("i_failed");
    expect(result.current.error?.message).toContain("X");
  });

  it("a stale run cannot stomp a newer reset()", async () => {
    const d = deferred<StartPluginImportResult>();
    mockStartFromZip.mockReturnValue(d.promise);

    const { result } = renderHook(() => usePluginImportRunner());
    let call!: Promise<StartPluginImportResult>;
    act(() => {
      call = result.current.startFromZip({
        projectId: "p",
        bundle: new Blob([]),
      });
    });
    // Reset while the run is still in flight, then let the stale run resolve.
    act(() => result.current.reset());
    expect(result.current.phase).toBe("idle");

    await act(async () => {
      d.resolve(okResult("late"));
      await call;
    });
    // The late resolution must NOT revive state past the reset.
    expect(result.current.phase).toBe("idle");
    expect(result.current.importId).toBeNull();
    await waitFor(() => expect(result.current.phase).toBe("idle"));
  });
});
