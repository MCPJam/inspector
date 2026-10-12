import { describe, expect, it, vi } from "vitest";
import { hydrateRecordedToolSnapshots } from "../recorded-tool-snapshots";

const snapshot = { version: 3, servers: [{ serverId: "server-1", tools: [] }] };
describe("recorded tool snapshot downloads", () => {
  it("keeps inline archives and loads file references without losing metadata", async () => {
    const load = vi.fn().mockResolvedValue(snapshot);
    const context = {
      modelId: "model",
      toolSnapshots: [
        { hash: "legacy", snapshot },
        {
          hash: "new",
          snapshot: null,
          snapshotUrl: "https://example.test/web/artifact?t=signed",
        },
      ],
    };
    expect(await hydrateRecordedToolSnapshots(context, load, vi.fn())).toEqual({
      ...context,
      toolSnapshots: [
        context.toolSnapshots[0],
        { ...context.toolSnapshots[1], snapshot },
      ],
    });
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("reports unavailable files and invalid JSON shapes without losing other entries", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("403"))
      .mockResolvedValueOnce({ notSnapshot: true });
    const report = vi.fn();
    const context = {
      toolSnapshots: [
        { snapshot: null, snapshotUrl: "expired" },
        { snapshot: null, snapshotUrl: "invalid" },
        { snapshot },
      ],
    };
    const result = await hydrateRecordedToolSnapshots(context, load, report);
    expect(result.toolSnapshots).toEqual([
      { ...context.toolSnapshots[0], snapshotUnavailable: true },
      { ...context.toolSnapshots[1], snapshotUnavailable: true },
      { snapshot },
    ]);
    expect(report).toHaveBeenCalledTimes(2);
  });
  it("preserves missing references and contexts with no catalog", async () => {
    const load = vi.fn();
    expect(await hydrateRecordedToolSnapshots({}, load, vi.fn())).toEqual({});
    const context = {
      toolSnapshots: [{ hash: "missing", snapshot: null, snapshotUrl: null }],
    };
    expect(await hydrateRecordedToolSnapshots(context, load, vi.fn())).toEqual(
      context,
    );
    expect(load).not.toHaveBeenCalled();
  });
});
