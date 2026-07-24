import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginImportRecord } from "@/lib/plugins/plugin-import-types";

const mockUseQuery = vi.fn();
vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useConvex: () => ({}),
}));

import { usePluginImport } from "../usePluginImport";

function record(status: PluginImportRecord["status"]): PluginImportRecord {
  return {
    importId: "import_1",
    projectId: "proj_1",
    status,
    createdAt: 0,
    updatedAt: 0,
    expiresAt: 0,
  };
}

describe("usePluginImport", () => {
  beforeEach(() => mockUseQuery.mockReset());

  it("skips the subscription when importId is nullish", () => {
    mockUseQuery.mockReturnValue(undefined);
    const { result } = renderHook(() => usePluginImport(null));
    // Second arg to useQuery must be the "skip" sentinel.
    expect(mockUseQuery.mock.calls[0][1]).toBe("skip");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.record).toBeUndefined();
  });

  it("reports loading while the row is undefined", () => {
    mockUseQuery.mockReturnValue(undefined);
    const { result } = renderHook(() => usePluginImport("import_1"));
    expect(result.current.isLoading).toBe(true);
  });

  it("derives phase flags from the row status", () => {
    mockUseQuery.mockReturnValue(record("preview_ready"));
    const { result } = renderHook(() => usePluginImport("import_1"));
    expect(result.current.isPreviewReady).toBe(true);
    expect(result.current.isTerminal).toBe(false);
    expect(result.current.isFailed).toBe(false);
  });

  it("marks completed and failed as terminal", () => {
    mockUseQuery.mockReturnValue(record("failed"));
    const failed = renderHook(() => usePluginImport("import_1"));
    expect(failed.result.current.isTerminal).toBe(true);
    expect(failed.result.current.isFailed).toBe(true);

    mockUseQuery.mockReturnValue(record("completed"));
    const done = renderHook(() => usePluginImport("import_1"));
    expect(done.result.current.isTerminal).toBe(true);
  });

  it("treats uploaded and inspecting as in-progress inspection", () => {
    for (const status of ["uploaded", "inspecting"] as const) {
      mockUseQuery.mockReturnValue(record(status));
      const { result } = renderHook(() => usePluginImport("import_1"));
      expect(result.current.isInspecting).toBe(true);
      expect(result.current.isTerminal).toBe(false);
    }
  });
});
