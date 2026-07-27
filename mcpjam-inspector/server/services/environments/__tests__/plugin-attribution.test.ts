import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import { fetchPluginRuntimeAttribution } from "../plugin-attribution";

function clientWith(
  query: (ref: string, args: { pluginVersionIds: string[] }) => unknown
): ConvexHttpClient {
  return { query: vi.fn(query) } as unknown as ConvexHttpClient;
}

const PREVIEW = "plugins:resolvePluginRuntimePreview";

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

  it("probes ONE version per call so components are attributable to a version", async () => {
    const client = clientWith((_ref, args) => {
      const id = args.pluginVersionIds[0];
      return {
        pluginVersions: [
          {
            pluginId: `p_${id}`,
            pluginVersionId: id,
            name: id === "pv_a" ? "alpha" : "beta",
            bundleHash: `hash_${id}`,
          },
        ],
        effectiveServerIds: [`srv_${id}`],
        pluginSkills: [
          {
            modelRef: `${id === "pv_a" ? "alpha" : "beta"}/summarize`,
            materializedSkillId: `sk_${id}`,
          },
        ],
        unavailableComponents: [],
      };
    });

    const result = await fetchPluginRuntimeAttribution(client, {
      projectId: "prj",
      pluginVersionIds: ["pv_a", "pv_b"],
    });

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query).toHaveBeenCalledWith(PREVIEW, {
      projectId: "prj",
      pluginVersionIds: ["pv_a"],
    });
    expect(result?.serverOrigins.get("srv_pv_a")).toEqual({
      pluginId: "p_pv_a",
      pluginVersionId: "pv_a",
      name: "alpha",
      bundleHash: "hash_pv_a",
    });
    expect(result?.skillOrigins.get("sk_pv_b")).toEqual({
      modelRef: "beta/summarize",
      plugin: {
        pluginId: "p_pv_b",
        pluginVersionId: "pv_b",
        name: "beta",
        bundleHash: "hash_pv_b",
      },
    });
  });

  it("returns null — never a partial map — when a probe fails", async () => {
    let calls = 0;
    const client = clientWith(() => {
      calls += 1;
      if (calls === 2) throw new Error("Could not find public function");
      return {
        pluginVersions: [
          {
            pluginId: "p",
            pluginVersionId: "pv_a",
            name: "alpha",
            bundleHash: "h",
          },
        ],
        effectiveServerIds: ["srv_a"],
        pluginSkills: [],
      };
    });

    const result = await fetchPluginRuntimeAttribution(client, {
      projectId: "prj",
      pluginVersionIds: ["pv_a", "pv_b"],
    });
    expect(result).toBeNull();
  });

  it("skips a version the probe reports as unavailable rather than inventing an origin", async () => {
    const client = clientWith((_ref, args) =>
      args.pluginVersionIds[0] === "pv_a"
        ? {
            pluginVersions: [],
            effectiveServerIds: [],
            pluginSkills: [],
            unavailableComponents: [
              { pluginVersionId: "pv_a", reason: "disabled" },
            ],
          }
        : {
            pluginVersions: [
              {
                pluginId: "p_b",
                pluginVersionId: "pv_b",
                name: "beta",
                bundleHash: "h_b",
              },
            ],
            effectiveServerIds: ["srv_b"],
            pluginSkills: [],
          }
    );

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
