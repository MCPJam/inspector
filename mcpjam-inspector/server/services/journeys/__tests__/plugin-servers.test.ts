// Decision D2 — the journey runner must never connect a plugin server on the
// strength of the snapshot alone.
//
// Every assertion here is about the NEGATIVE case: the snapshot still names the
// plugin, and the resolution must either verify it live or refuse. Returning
// `[]` on an unverifiable target would silently shrink the environment, which
// is the failure the whole re-gate exists to prevent.

import { describe, expect, it, vi } from "vitest";
import {
  JourneyPluginServersUnavailableError,
  resolveTargetPluginServerIds,
} from "../plugin-servers.js";

function clientReturning(value: unknown) {
  return { query: vi.fn().mockResolvedValue(value) } as never;
}
function clientThrowing(error: Error) {
  return { query: vi.fn().mockRejectedValue(error) } as never;
}

describe("resolveTargetPluginServerIds", () => {
  it("returns [] without querying when the target pinned no plugin servers", async () => {
    const client = clientReturning(null);
    await expect(
      resolveTargetPluginServerIds(client, {
        runId: "run1",
        targetId: "environment:e1",
      })
    ).resolves.toEqual([]);
    // Not querying is what keeps every plugin-free journey working against a
    // backend that hasn't deployed the D2 query yet.
    expect(
      (client as unknown as { query: ReturnType<typeof vi.fn> }).query
    ).not.toHaveBeenCalled();
  });

  it("returns the live-verified server ids", async () => {
    const client = clientReturning({
      targets: [
        {
          targetId: "environment:e1",
          servers: [
            {
              serverId: "srv_plugin",
              name: "acme:tool",
              pluginVersionId: "pv1",
              pluginId: "p1",
              pluginName: "acme",
              componentKey: "srv-1",
            },
          ],
          unavailable: [],
          droppedSnapshotServerIds: [],
        },
      ],
    });
    await expect(
      resolveTargetPluginServerIds(client, {
        runId: "run1",
        targetId: "environment:e1",
        snapshotPluginServerIds: ["srv_plugin"],
      })
    ).resolves.toEqual(["srv_plugin"]);
  });

  it("throws — naming the plugin — when a pin is no longer usable", async () => {
    const client = clientReturning({
      targets: [
        {
          targetId: "environment:e1",
          servers: [],
          unavailable: [
            {
              pluginVersionId: "pv1",
              reason: "uninstalled",
              pluginName: "acme",
            },
          ],
          droppedSnapshotServerIds: [],
        },
      ],
    });
    await expect(
      resolveTargetPluginServerIds(client, {
        runId: "run1",
        targetId: "environment:e1",
        snapshotPluginServerIds: ["srv_plugin"],
      })
    ).rejects.toThrow(/"acme" was uninstalled/);
  });

  it("throws on shrinkage even when every pin resolved", async () => {
    const client = clientReturning({
      targets: [
        {
          targetId: "environment:e1",
          servers: [],
          unavailable: [],
          droppedSnapshotServerIds: ["srv_plugin"],
        },
      ],
    });
    await expect(
      resolveTargetPluginServerIds(client, {
        runId: "run1",
        targetId: "environment:e1",
        snapshotPluginServerIds: ["srv_plugin"],
      })
    ).rejects.toThrow(JourneyPluginServersUnavailableError);
  });

  it("treats the backend's null 'no answer' as a refusal, not an empty list", async () => {
    const client = clientReturning(null);
    await expect(
      resolveTargetPluginServerIds(client, {
        runId: "run1",
        targetId: "environment:gone",
        snapshotPluginServerIds: ["srv_plugin"],
      })
    ).rejects.toThrow(JourneyPluginServersUnavailableError);
  });

  it("fails closed when the backend can't answer the query yet", async () => {
    const client = clientThrowing(
      new Error("Could not find public function for 'journeyRuns:x'")
    );
    await expect(
      resolveTargetPluginServerIds(client, {
        runId: "run1",
        targetId: "environment:e1",
        snapshotPluginServerIds: ["srv_plugin"],
      })
    ).rejects.toThrow(/can't verify pinned plugins yet/);
  });

  it("refuses a snapshot that pins plugin servers but carries no target id", async () => {
    const client = clientReturning({ targets: [] });
    await expect(
      resolveTargetPluginServerIds(client, {
        runId: "run1",
        snapshotPluginServerIds: ["srv_plugin"],
      })
    ).rejects.toThrow(/no target id/);
  });
});
