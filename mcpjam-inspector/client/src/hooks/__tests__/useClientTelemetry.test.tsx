import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordClientEventMock } = vi.hoisted(() => ({
  recordClientEventMock: vi.fn().mockResolvedValue(null),
}));

vi.mock("convex/react", () => ({
  useMutation: () => recordClientEventMock,
}));

import { useEmbeddedBlobReadTelemetry } from "../useClientTelemetry";

describe("useEmbeddedBlobReadTelemetry", () => {
  beforeEach(() => {
    recordClientEventMock.mockReset();
    recordClientEventMock.mockResolvedValue(null);
  });

  it("fires recordClientEvent with the embedded_servers_blob_read event", () => {
    const { result } = renderHook(() => useEmbeddedBlobReadTelemetry());

    act(() => {
      result.current({ projectId: "proj_a", serverCount: 3 });
    });

    expect(recordClientEventMock).toHaveBeenCalledTimes(1);
    const args = recordClientEventMock.mock.calls[0][0];
    expect(args.event).toBe("embedded_servers_blob_read");
    expect(args.properties.project_id).toBe("proj_a");
    expect(args.properties.server_count).toBe(3);
    expect(args.properties.location).toBe("project_picker");
  });

  it("dedupes repeated emits for the same project across re-renders", () => {
    const { result, rerender } = renderHook(() =>
      useEmbeddedBlobReadTelemetry(),
    );

    act(() => {
      result.current({ projectId: "proj_a", serverCount: 1 });
      result.current({ projectId: "proj_a", serverCount: 2 });
      result.current({ projectId: "proj_a", serverCount: 5 });
    });
    rerender();
    act(() => {
      result.current({ projectId: "proj_a", serverCount: 7 });
    });

    expect(recordClientEventMock).toHaveBeenCalledTimes(1);
  });

  it("fires separately for distinct projects", () => {
    const { result } = renderHook(() => useEmbeddedBlobReadTelemetry());

    act(() => {
      result.current({ projectId: "proj_a", serverCount: 1 });
      result.current({ projectId: "proj_b", serverCount: 2 });
      result.current({ projectId: "proj_a", serverCount: 99 });
    });

    expect(recordClientEventMock).toHaveBeenCalledTimes(2);
    const ids = recordClientEventMock.mock.calls.map(
      (c) => c[0].properties.project_id,
    );
    expect(ids).toEqual(["proj_a", "proj_b"]);
  });

  it("swallows mutation rejections so the picker is unaffected", async () => {
    recordClientEventMock.mockReset();
    recordClientEventMock.mockRejectedValue(new Error("backend down"));

    const { result } = renderHook(() => useEmbeddedBlobReadTelemetry());

    // Must not throw synchronously.
    act(() => {
      result.current({ projectId: "proj_a", serverCount: 1 });
    });
    // And must not produce an unhandled rejection that fails the test.
    await new Promise((r) => setTimeout(r, 0));
    expect(recordClientEventMock).toHaveBeenCalledTimes(1);
  });
});
