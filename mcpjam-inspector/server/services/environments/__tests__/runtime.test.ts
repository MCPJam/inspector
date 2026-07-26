import { describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import {
  resolveEnvironmentForRuntime,
  runtimeServerIds,
  runtimeServerNames,
  runtimeServersAreOverridden,
  runtimeSkills,
  toEnvironmentPreview,
  translateEnvironmentRuntimeError,
  type ResolvedEnvironmentRuntime,
} from "../runtime";

const SPEC: ResolvedEnvironmentRuntime = {
  specVersion: 1,
  environmentRef: { environmentId: "env_1", name: "Staging", revision: 7 },
  host: {
    hostId: "host_1",
    hostName: "Alpha",
    hostConfigId: "hc_1",
    runtimeConfig: {
      hostId: "host_1",
      hostConfigId: "hc_1",
      modelId: "openai/gpt-5-mini",
      systemPrompt: "be nice",
      temperature: 0.4,
      requireToolApproval: true,
      respectToolVisibility: false,
      progressiveToolDiscovery: true,
      hostStyle: "claude",
      builtInToolIds: ["web_search"],
      harness: "claude-code",
      computer: { kind: "personal", workdir: "/home/user/work" },
      mcpProfile: { extensions: { "com.mcpjam/enterprise-managed-auth": {} } },
    },
  },
  servers: {
    selectedServerIds: ["ps_1"],
    pluginServerIds: ["ps_plugin"],
    baseEffectiveServerIds: ["ps_1", "ps_plugin"],
    effectiveServerIds: ["ps_1", "ps_plugin"],
    connectable: [
      { serverId: "ps_1", name: "linear", source: "host_or_group" },
      { serverId: "ps_plugin", name: "asana", source: "plugin" },
    ],
  },
  skills: [
    {
      skillId: "sk_1",
      name: "pdf-processing",
      description: "Fill PDFs",
      content: "SECRET INSTRUCTIONS",
      aggregateHash: "agg1",
      channels: ["host", "environment"],
      files: [
        { path: "scripts/fill.py", size: 12, url: "https://signed.example/1" },
      ],
    },
    {
      skillId: "sk_2",
      name: "release-notes",
      description: "Write notes",
      content: "MORE SECRET INSTRUCTIONS",
      aggregateHash: "agg2",
      channels: ["plugin"],
      files: [],
    },
  ],
  pluginVersions: [
    {
      pluginId: "pl_1",
      pluginVersionId: "pv_1",
      name: "linear",
      bundleHash: "abc123",
    },
  ],
};

function fakeConvexClient(result: unknown, capture?: (args: unknown) => void) {
  return {
    query: async (_ref: unknown, args: unknown) => {
      capture?.(args);
      return result;
    },
  } as unknown as Parameters<typeof resolveEnvironmentForRuntime>[0];
}

describe("resolveEnvironmentForRuntime", () => {
  it("returns the resolver's spec untouched", async () => {
    const spec = await resolveEnvironmentForRuntime(fakeConvexClient(SPEC), {
      projectId: "p_1",
      environmentId: "env_1",
    });
    expect(spec).toEqual(SPEC);
  });

  it("keeps an ABSENT override distinct from an EMPTY one on the wire", async () => {
    const calls: unknown[] = [];
    const client = fakeConvexClient(SPEC, (args) => calls.push(args));

    await resolveEnvironmentForRuntime(client, {
      projectId: "p_1",
      environmentId: "env_1",
    });
    expect(calls[0]).not.toHaveProperty("serverOverrideIds");

    await resolveEnvironmentForRuntime(client, {
      projectId: "p_1",
      environmentId: "env_1",
      overrides: { serverIds: [] },
    });
    expect(calls[1]).toMatchObject({ serverOverrideIds: [] });
  });

  it("TOLERATES a backend that omits additive fields", async () => {
    // Older/newer deploy: no skills, no plugin versions, no connectable
    // projection, no specVersion. None of those is an invariant.
    const lean = {
      environmentRef: { environmentId: "env_1", name: "Staging", revision: 2 },
      host: { hostId: "host_1", runtimeConfig: { modelId: "m" } },
      servers: { effectiveServerIds: ["ps_1"] },
    };
    const spec = await resolveEnvironmentForRuntime(fakeConvexClient(lean), {
      projectId: "p_1",
      environmentId: "env_1",
    });
    expect(runtimeServerIds(spec)).toEqual(["ps_1"]);
    expect(runtimeServerNames(spec)).toEqual([]);
    expect(runtimeSkills(spec)).toEqual([]);
  });

  it("FAILS CLOSED when an identity or host invariant is missing", async () => {
    const cases: Array<[string, unknown]> = [
      ["null", null],
      ["no environmentRef", { host: {}, servers: {} }],
      [
        "no revision",
        {
          environmentRef: { environmentId: "env_1", name: "n" },
          host: { hostId: "h", runtimeConfig: {} },
          servers: { effectiveServerIds: [] },
        },
      ],
      [
        "no host runtimeConfig",
        {
          environmentRef: { environmentId: "env_1", name: "n", revision: 1 },
          host: { hostId: "h" },
          servers: { effectiveServerIds: [] },
        },
      ],
      [
        "no effective server set",
        {
          environmentRef: { environmentId: "env_1", name: "n", revision: 1 },
          host: { hostId: "h", runtimeConfig: {} },
          servers: {},
        },
      ],
    ];
    for (const [, bad] of cases) {
      await expect(
        resolveEnvironmentForRuntime(fakeConvexClient(bad), {
          projectId: "p_1",
          environmentId: "env_1",
        })
      ).rejects.toMatchObject({ status: 502 });
    }
  });

  it("maps a missing backend function to a readable 400 (deploy-order skew)", async () => {
    const client = {
      query: async () => {
        throw new Error(
          "Could not find public function for 'projectEnvironments:resolveEnvironmentForRuntime'"
        );
      },
    } as unknown as Parameters<typeof resolveEnvironmentForRuntime>[0];
    await expect(
      resolveEnvironmentForRuntime(client, {
        projectId: "p_1",
        environmentId: "env_1",
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("translateEnvironmentRuntimeError", () => {
  it("passes the ENV_* family through as a 409 carrying the machine code", () => {
    const err = translateEnvironmentRuntimeError(
      new ConvexError({
        code: "ENV_PLUGIN_UNAVAILABLE",
        message: "Plugin can no longer provide its server",
      })
    );
    expect(err.status).toBe(409);
    expect(err.details).toMatchObject({ code: "ENV_PLUGIN_UNAVAILABLE" });
    expect(err.message).toMatch(/no longer provide/);
  });

  it("404s the not-there codes so a non-member learns nothing", () => {
    for (const code of ["ENV_NOT_FOUND", "ENV_CROSS_PROJECT", "FORBIDDEN"]) {
      expect(
        translateEnvironmentRuntimeError(new ConvexError({ code })).status
      ).toBe(404);
    }
  });

  it("maps VALIDATION to a 400", () => {
    expect(
      translateEnvironmentRuntimeError(
        new ConvexError({ code: "VALIDATION", message: "bad server id" })
      ).status
    ).toBe(400);
  });
});

describe("runtime projections", () => {
  it("prefers the live-healed connectable ids/names", () => {
    expect(runtimeServerIds(SPEC)).toEqual(["ps_1", "ps_plugin"]);
    expect(runtimeServerNames(SPEC)).toEqual(["linear", "asana"]);
  });

  it("detects a per-turn override against the base set", () => {
    expect(runtimeServersAreOverridden(SPEC)).toBe(false);
    expect(
      runtimeServersAreOverridden({
        ...SPEC,
        servers: { ...SPEC.servers, effectiveServerIds: ["ps_1"] },
      })
    ).toBe(true);
    // An empty override is still an override.
    expect(
      runtimeServersAreOverridden({
        ...SPEC,
        servers: { ...SPEC.servers, effectiveServerIds: [] },
      })
    ).toBe(true);
  });

  it("projects skills into the runtime skill shape the engines consume", () => {
    expect(runtimeSkills(SPEC)).toEqual([
      {
        skillId: "sk_1",
        name: "pdf-processing",
        description: "Fill PDFs",
        content: "SECRET INSTRUCTIONS",
        aggregateHash: "agg1",
      },
      {
        skillId: "sk_2",
        name: "release-notes",
        description: "Write notes",
        content: "MORE SECRET INSTRUCTIONS",
        aggregateHash: "agg2",
      },
    ]);
  });
});

describe("toEnvironmentPreview", () => {
  const preview = toEnvironmentPreview(SPEC, {
    harnessSupportsSkills: () => true,
  });

  it("STRIPS skill content and every supporting-file reference", () => {
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain("SECRET INSTRUCTIONS");
    expect(serialized).not.toContain("signed.example");
    expect(serialized).not.toContain("scripts/fill.py");
    expect(preview.skills[0]).toEqual({
      skillId: "sk_1",
      name: "pdf-processing",
      description: "Fill PDFs",
      channels: ["host", "environment"],
      hasFiles: true,
    });
    expect(preview.skills[1].hasFiles).toBe(false);
  });

  it("STRIPS raw computer config, mcpProfile, and every unlisted runtimeConfig field", () => {
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain("/home/user/work");
    expect(serialized).not.toContain("enterprise-managed-auth");
    expect(serialized).not.toContain("be nice"); // systemPrompt
    expect(preview.capabilities.hasComputer).toBe(true);
  });

  it("cannot leak a NEW runtime-spec field (projection is explicit, never a spread)", () => {
    // The regression this locks: someone adds a field to the runtime spec and
    // the preview quietly starts serving it.
    const leaky = toEnvironmentPreview(
      {
        ...SPEC,
        host: {
          ...SPEC.host,
          runtimeConfig: {
            ...SPEC.host.runtimeConfig,
            brokerSecret: "sk_live_do_not_ship",
          },
        },
        skills: [
          {
            ...SPEC.skills![0],
            // A hypothetical future artifact field.
            signedBundleUrl: "https://signed.example/bundle",
          } as never,
        ],
      },
      { harnessSupportsSkills: () => true }
    );
    const serialized = JSON.stringify(leaky);
    expect(serialized).not.toContain("sk_live_do_not_ship");
    expect(serialized).not.toContain("signed.example/bundle");
  });

  it("summarizes identity, servers, plugins and capabilities", () => {
    expect(preview.environment).toEqual({
      environmentId: "env_1",
      name: "Staging",
      revision: 7,
    });
    expect(preview.host).toEqual({
      hostId: "host_1",
      hostName: "Alpha",
      hostConfigId: "hc_1",
      modelId: "openai/gpt-5-mini",
      hostStyle: "claude",
      harness: "claude-code",
    });
    expect(preview.servers).toEqual([
      { serverId: "ps_1", name: "linear", source: "host_or_group" },
      { serverId: "ps_plugin", name: "asana", source: "plugin" },
    ]);
    expect(preview.plugins).toEqual([
      { pluginId: "pl_1", pluginVersionId: "pv_1", name: "linear" },
    ]);
    expect(preview.capabilities).toMatchObject({
      requireToolApproval: true,
      respectToolVisibility: false,
      progressiveToolDiscovery: true,
      builtInToolIds: ["web_search"],
      serverCount: 2,
      skillCount: 2,
      pluginCount: 1,
      skillDelivery: "harness",
      serversOverridden: false,
    });
  });

  it("reports `unsupported` skill delivery for a skills-incapable harness", () => {
    // Codex delivers no skills today. Saying "harness" here would claim a
    // delivery that never happens.
    const codex = toEnvironmentPreview(SPEC, {
      harnessSupportsSkills: () => false,
    });
    expect(codex.capabilities.skillDelivery).toBe("unsupported");
  });

  it("reports `emulated` when the environment's host runs no harness", () => {
    const emulated = toEnvironmentPreview(
      {
        ...SPEC,
        host: {
          ...SPEC.host,
          runtimeConfig: { modelId: "openai/gpt-5-mini" },
        },
      },
      { harnessSupportsSkills: vi.fn(() => true) }
    );
    expect(emulated.capabilities.skillDelivery).toBe("emulated");
    expect(emulated.capabilities.hasComputer).toBe(false);
  });
});
