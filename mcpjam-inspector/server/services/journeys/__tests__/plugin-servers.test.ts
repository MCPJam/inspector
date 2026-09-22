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
  const client = { query: vi.fn().mockResolvedValue(value) };
  const get = () => client as never;
  return Object.assign(get, { client });
}
function clientThrowing(error: Error) {
  return (() => ({ query: vi.fn().mockRejectedValue(error) })) as never;
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
    expect(client.client.query).not.toHaveBeenCalled();
  });

  // Regression: the client is built from a THUNK, never eagerly. This runs
  // after the journey run row exists, and `createConvexClient` throws when
  // CONVEX_URL is unset — an eager build would turn a config gap into a durable
  // run with no runner (an orphan), for journeys that pin no plugins at all.
  it("never constructs a client when the target pinned no plugin servers", async () => {
    let built = 0;
    const getClient = () => {
      built += 1;
      throw new Error("CONVEX_URL is not set");
    };
    await expect(
      resolveTargetPluginServerIds(getClient as never, {
        runId: "run1",
        targetId: "environment:e1",
      })
    ).resolves.toEqual([]);
    expect(built).toBe(0);
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

  // Codex P1. Deploy skew can hand us a shape we don't recognize, and a
  // permissive read of one is indistinguishable from a clean all-clear —
  // `{ targets: [{}] }` used to fall through three `?? []` defaults and return
  // [], silently dropping the plugin. Each required array is asserted
  // independently so a partial payload can't sneak through on the strength of
  // the others.
  it.each([
    ["an empty target object", {}],
    [
      "a target missing servers",
      { unavailable: [], droppedSnapshotServerIds: [] },
    ],
    [
      "a target missing unavailable",
      { servers: [], droppedSnapshotServerIds: [] },
    ],
    [
      "a target missing droppedSnapshotServerIds",
      { servers: [], unavailable: [] },
    ],
    [
      "non-array fields",
      { servers: {}, unavailable: {}, droppedSnapshotServerIds: {} },
    ],
  ])(
    "rejects %s rather than reading it as 'no plugins'",
    async (_label, target) => {
      await expect(
        resolveTargetPluginServerIds(clientReturning({ targets: [target] }), {
          runId: "run1",
          targetId: "environment:e1",
          snapshotPluginServerIds: ["srv_plugin"],
        })
      ).rejects.toThrow(JourneyPluginServersUnavailableError);
    }
  );

  it("rejects a response resolved against a DIFFERENT target", async () => {
    await expect(
      resolveTargetPluginServerIds(
        clientReturning({
          targets: [
            {
              targetId: "environment:other",
              servers: [],
              unavailable: [],
              droppedSnapshotServerIds: [],
            },
          ],
        }),
        {
          runId: "run1",
          targetId: "environment:e1",
          snapshotPluginServerIds: ["srv_plugin"],
        }
      )
    ).rejects.toThrow(/different target/);
  });

  it("rejects a server entry with no usable id", async () => {
    await expect(
      resolveTargetPluginServerIds(
        clientReturning({
          targets: [
            {
              targetId: "environment:e1",
              servers: [{ name: "acme:tool" }],
              unavailable: [],
              droppedSnapshotServerIds: [],
            },
          ],
        }),
        {
          runId: "run1",
          targetId: "environment:e1",
          snapshotPluginServerIds: ["srv_plugin"],
        }
      )
    ).rejects.toThrow(/unrecognized server entry/);
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

// The resume-config leak this PR nearly shipped.
//
// `resumeConfig.selectedServers` is a DURABLE reconnect instruction, replayed
// by the Sessions viewer with no plugin lifecycle check. Unioning plugin server
// ids into `connectedServerIds` (which the runner copies into resumeConfig)
// therefore recreated, through a different door, the exact bypass that keeps
// `plugin_component` ids out of `hostConfigs.serverIds`: a stored id that
// outlives the plugin's disable/uninstall.
describe("resumeConfig must not carry plugin server ids", () => {
  // Mirrors the filter in sessionSimulation/runner.ts so the invariant is
  // pinned even though the runner itself needs a full session to exercise.
  function resumeServers(
    connectedServerIds: string[],
    nonResumableServerIds: string[] | undefined,
    connectedServerNames?: string[]
  ): string[] {
    const nonResumable = new Set(nonResumableServerIds ?? []);
    return Array.isArray(connectedServerNames) &&
      connectedServerNames.length === connectedServerIds.length
      ? connectedServerNames.filter(
          (_, i) => !nonResumable.has(connectedServerIds[i]!)
        )
      : connectedServerIds.filter((id) => !nonResumable.has(id));
  }

  it("drops plugin ids while keeping the host's own servers", () => {
    expect(resumeServers(["srv_host", "srv_plugin"], ["srv_plugin"])).toEqual([
      "srv_host",
    ]);
  });

  it("drops the aligned NAME when names are supplied", () => {
    // Index alignment is the contract; filtering names by value would drop the
    // wrong entry whenever two servers share a display name.
    expect(
      resumeServers(
        ["srv_host", "srv_plugin"],
        ["srv_plugin"],
        ["shared-name", "shared-name"]
      )
    ).toEqual(["shared-name"]);
  });

  it("is a no-op for a target with no plugin servers", () => {
    expect(resumeServers(["srv_host"], undefined)).toEqual(["srv_host"]);
  });
});
