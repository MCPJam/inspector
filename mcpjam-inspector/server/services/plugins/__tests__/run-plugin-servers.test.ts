// Decision D2 for SUITE runs (BE-5). Same bar as the journey twin: the run
// snapshot still names the plugin, and the resolution must either verify it
// live or refuse. Returning `[]` on an unverifiable run would silently shrink
// the environment the eval measured — which is the failure the re-gate exists
// to prevent, and the one that makes a green run a lie.

import { describe, expect, it, vi } from "vitest";
import {
  RunPluginServersUnavailableError,
  resolveSuiteRunPluginServers,
} from "../run-plugin-servers.js";

function clientReturning(value: unknown) {
  const client = { query: vi.fn().mockResolvedValue(value) };
  const get = () => client as never;
  return Object.assign(get, { client });
}
function clientThrowing(error: Error) {
  const client = { query: vi.fn().mockRejectedValue(error) };
  const get = () => client as never;
  return Object.assign(get, { client });
}

const CLEAN = { servers: [], unavailable: [], droppedSnapshotServerIds: [] };

describe("resolveSuiteRunPluginServers", () => {
  it("returns the rich rows on a clean resolution", async () => {
    const client = clientReturning({
      ...CLEAN,
      servers: [
        {
          serverId: "s1",
          name: "acme-api",
          pluginVersionId: "pv1",
          pluginId: "p1",
          pluginName: "acme",
          componentKey: "api",
        },
      ],
    });
    await expect(
      resolveSuiteRunPluginServers(client, { runId: "run1" })
    ).resolves.toEqual([
      {
        serverId: "s1",
        name: "acme-api",
        pluginVersionId: "pv1",
        pluginId: "p1",
        pluginName: "acme",
        componentKey: "api",
      },
    ]);
    expect(client.client.query).toHaveBeenCalledWith(
      "testSuites:resolveRunPluginServersForExecution",
      { runId: "run1" }
    );
  });

  // The backend's documented all-clear for a run that pinned nothing (every
  // legacy run included). This is what lets the caller invoke it
  // unconditionally instead of first reading the snapshot back.
  it("treats the empty three-list envelope as a genuine all-clear", async () => {
    await expect(
      resolveSuiteRunPluginServers(clientReturning(CLEAN), { runId: "run1" })
    ).resolves.toEqual([]);
  });

  it.each([
    ["null", null],
    ["an empty object", {}],
    ["servers only", { servers: [] }],
    // The one that motivates requiring all three: two lists present reads as a
    // clean answer if the third is allowed to default.
    [
      "a missing unavailable list",
      { servers: [], droppedSnapshotServerIds: [] },
    ],
    [
      "a missing dropped list",
      { servers: [], unavailable: [] },
    ],
  ])("rejects %s rather than reading it as 'no plugins'", async (_label, value) => {
    await expect(
      resolveSuiteRunPluginServers(clientReturning(value), { runId: "run1" })
    ).rejects.toThrow(RunPluginServersUnavailableError);
  });

  it("names the plugin and the reason so the failure is attributable", async () => {
    await expect(
      resolveSuiteRunPluginServers(
        clientReturning({
          ...CLEAN,
          unavailable: [
            { pluginVersionId: "pv1", reason: "uninstalled", pluginName: "acme" },
          ],
        }),
        { runId: "run1" }
      )
    ).rejects.toThrow(/"acme" was uninstalled/);
  });

  it("names the component when the backend identified one", async () => {
    await expect(
      resolveSuiteRunPluginServers(
        clientReturning({
          ...CLEAN,
          unavailable: [
            {
              pluginVersionId: "pv1",
              reason: "server_missing",
              pluginName: "acme",
              componentKey: "api",
            },
          ],
        }),
        { runId: "run1" }
      )
    ).rejects.toThrow(/"acme" no longer provides its server "api"/);
  });

  // Reason codes are a backend-owned union that will grow. An unknown one must
  // still stop the run and say what it was.
  it("stops on an unrecognized reason code and reports it verbatim", async () => {
    await expect(
      resolveSuiteRunPluginServers(
        clientReturning({
          ...CLEAN,
          unavailable: [{ pluginVersionId: "pv1", reason: "quarantined" }],
        }),
        { runId: "run1" }
      )
    ).rejects.toThrow(/is unavailable \(quarantined\)/);
  });

  // The backend suppresses this list whenever `unavailable` already explains
  // the shrinkage, so a non-empty one here always means a server vanished with
  // NO version-level explanation.
  it("stops on a dropped snapshot server id with no unavailable entry", async () => {
    await expect(
      resolveSuiteRunPluginServers(
        clientReturning({ ...CLEAN, droppedSnapshotServerIds: ["s9"] }),
        { runId: "run1" }
      )
    ).rejects.toThrow(/a pinned plugin server \(s9\) is no longer provided/);
  });

  it("rejects a server entry with no usable id", async () => {
    await expect(
      resolveSuiteRunPluginServers(
        clientReturning({ ...CLEAN, servers: [{ name: "acme-api" }] }),
        { runId: "run1" }
      )
    ).rejects.toThrow(/unrecognized server entry/);
  });

  it("fails closed when the backend has not deployed the query", async () => {
    await expect(
      resolveSuiteRunPluginServers(
        clientThrowing(
          new Error("Could not find public function for 'testSuites:x'")
        ),
        { runId: "run1" }
      )
    ).rejects.toThrow(/can't verify this run's pinned plugins yet/);
  });

  // A legacy (non-environment) suite run cannot carry a pin at all — the
  // environment is the only pin carrier — so failing it for a capability it
  // structurally cannot have would break every such run on an older backend.
  it("allows an undeployed backend ONLY for a run that cannot pin plugins", async () => {
    await expect(
      resolveSuiteRunPluginServers(
        clientThrowing(
          new Error("Could not find public function for 'testSuites:x'")
        ),
        { runId: "run1", allowUndeployedBackend: true }
      )
    ).resolves.toEqual([]);
  });

  // ...and that escape hatch must not swallow anything else. A transport
  // failure is not evidence that there are no plugins.
  it("still throws a non-deploy-skew error under allowUndeployedBackend", async () => {
    await expect(
      resolveSuiteRunPluginServers(clientThrowing(new Error("network down")), {
        runId: "run1",
        allowUndeployedBackend: true,
      })
    ).rejects.toThrow(/network down/);
  });
});
