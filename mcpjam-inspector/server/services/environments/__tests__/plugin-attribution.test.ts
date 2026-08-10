import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import { fetchPluginRuntimeAttribution } from "../plugin-attribution";

function clientWith(
  query: (ref: string, args: { pluginVersionIds: string[] }) => unknown
): ConvexHttpClient {
  return { query: vi.fn(query) } as unknown as ConvexHttpClient;
}

const PREVIEW = "plugins:resolvePluginRuntimePreview";

/** A well-formed probe response for two pinned versions. */
function twoVersionResponse() {
  return {
    pluginVersions: [
      {
        pluginId: "p_a",
        pluginVersionId: "pv_a",
        name: "alpha",
        bundleHash: "hash_a",
      },
      {
        pluginId: "p_b",
        pluginVersionId: "pv_b",
        name: "beta",
        bundleHash: "hash_b",
      },
    ],
    effectiveServerIds: ["srv_a", "srv_b"],
    serverComponents: [
      {
        pluginVersionId: "pv_a",
        componentKey: "server:api",
        placement: "remote",
        authenticationPolicy: "on_use",
        materializedServerId: "srv_a",
      },
      {
        pluginVersionId: "pv_b",
        componentKey: "server:tools",
        placement: "remote",
        authenticationPolicy: "on_use",
        materializedServerId: "srv_b",
      },
    ],
    pluginSkills: [
      {
        pluginVersionId: "pv_b",
        modelRef: "beta/summarize",
        materializedSkillId: "sk_b",
      },
    ],
    unavailableComponents: [],
  };
}

describe("fetchPluginRuntimeAttribution", () => {
  it("costs zero reads when the environment pins no plugins", async () => {
    const query = vi.fn();
    const result = await fetchPluginRuntimeAttribution(
      { query } as unknown as ConvexHttpClient,
      { projectId: "prj", pluginVersionIds: [] }
    );
    expect(query).not.toHaveBeenCalled();
    expect(result).toEqual({
      serverOrigins: new Map(),
      skillOrigins: new Map(),
      unattributedVersionIds: [],
    });
  });

  it("attributes every component from ONE call covering the whole pin set", async () => {
    const client = clientWith(() => twoVersionResponse());

    const result = await fetchPluginRuntimeAttribution(client, {
      projectId: "prj",
      pluginVersionIds: ["pv_a", "pv_b"],
    });

    // The historical per-version fan-out is gone: one probe, all edges.
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(PREVIEW, {
      projectId: "prj",
      pluginVersionIds: ["pv_a", "pv_b"],
    });
    expect(result?.serverOrigins.get("srv_a")).toEqual({
      pluginId: "p_a",
      pluginVersionId: "pv_a",
      name: "alpha",
      bundleHash: "hash_a",
    });
    expect(result?.serverOrigins.get("srv_b")?.name).toBe("beta");
    expect(result?.skillOrigins.get("sk_b")).toEqual({
      modelRef: "beta/summarize",
      plugin: {
        pluginId: "p_b",
        pluginVersionId: "pv_b",
        name: "beta",
        bundleHash: "hash_b",
      },
    });
    expect(result?.unattributedVersionIds).toEqual([]);
  });

  it("returns null — never a partial map — when the probe fails", async () => {
    const client = clientWith(() => {
      throw new Error("Could not find public function");
    });
    const result = await fetchPluginRuntimeAttribution(client, {
      projectId: "prj",
      pluginVersionIds: ["pv_a", "pv_b"],
    });
    expect(result).toBeNull();
  });

  it("returns null when the deployed backend omits serverComponents (deploy skew)", async () => {
    // An older probe without component rows cannot supply the version edge —
    // guessing from the flat effectiveServerIds list would misattribute.
    const client = clientWith(() => ({
      pluginVersions: twoVersionResponse().pluginVersions,
      effectiveServerIds: ["srv_a", "srv_b"],
      pluginSkills: [],
    }));
    const result = await fetchPluginRuntimeAttribution(client, {
      projectId: "prj",
      pluginVersionIds: ["pv_a", "pv_b"],
    });
    expect(result).toBeNull();
  });

  it("reports a version the probe drops as unattributed rather than inventing an origin", async () => {
    const response = twoVersionResponse();
    // pv_a became unavailable between the environment read and this probe.
    response.pluginVersions = response.pluginVersions.filter(
      (version) => version.pluginVersionId !== "pv_a"
    );
    response.serverComponents = response.serverComponents.filter(
      (component) => component.pluginVersionId !== "pv_a"
    );
    response.unavailableComponents = [
      { pluginVersionId: "pv_a", reason: "disabled" },
    ] as never[];
    const client = clientWith(() => response);

    const result = await fetchPluginRuntimeAttribution(client, {
      projectId: "prj",
      pluginVersionIds: ["pv_a", "pv_b"],
    });
    expect(result?.serverOrigins.size).toBe(1);
    expect(result?.serverOrigins.has("srv_b")).toBe(true);
    // The short map must ANNOUNCE that it is short — a caller that read only
    // `serverOrigins` would otherwise present pv_a's servers as origin-free.
    expect(result?.unattributedVersionIds).toEqual(["pv_a"]);
  });

  it("gives up on a read that never settles instead of hanging the turn", async () => {
    vi.useFakeTimers();
    try {
      // A Convex query that never resolves — the failure the deadline exists
      // for. Without it the chat route blocks forever before the turn starts.
      const client = clientWith(() => new Promise(() => {}));
      const pending = fetchPluginRuntimeAttribution(client, {
        projectId: "prj",
        pluginVersionIds: ["pv_a"],
      });
      await vi.advanceTimersByTimeAsync(5_000);
      // Fails CLOSED, exactly like every other probe failure.
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tolerates a missing bundleHash without dropping the origin", async () => {
    const client = clientWith(() => ({
      pluginVersions: [
        { pluginId: "p", pluginVersionId: "pv_a", name: "alpha" },
      ],
      effectiveServerIds: ["srv_a"],
      serverComponents: [
        { pluginVersionId: "pv_a", materializedServerId: "srv_a" },
      ],
      pluginSkills: [],
    }));
    const result = await fetchPluginRuntimeAttribution(client, {
      projectId: "prj",
      pluginVersionIds: ["pv_a"],
    });
    expect(result?.serverOrigins.get("srv_a")?.bundleHash).toBeNull();
    expect(result?.unattributedVersionIds).toEqual([]);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
