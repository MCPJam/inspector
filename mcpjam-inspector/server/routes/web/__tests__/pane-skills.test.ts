import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, postJson } from "./helpers/test-app.js";

const { query, host } = vi.hoisted(() => ({ query: vi.fn(), host: vi.fn() }));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    query = query;
    setAuth = vi.fn();
  },
}));
vi.mock("../../../utils/host-runtime-config.js", async (original) => ({
  ...(await original<typeof import("../../../utils/host-runtime-config.js")>()),
  fetchHostRuntimeConfig: host,
}));

const skill = (skillId: string, name: string, channels: string[]) => ({
  skillId,
  name,
  description: name,
  channels,
  aggregateHash: "x",
  content: "private instructions",
  files: [{ path: "private.txt", url: "signed-url", size: 2 }],
});
const ordinary = skill("s1", "research", ["environment"]);
const plugin = skill("s2", "docs", ["plugin"]);
const pin = { pluginId: "p1", pluginVersionId: "v1", name: "plugin" };
const spec = {
  environmentRef: { environmentId: "env1", name: "Pinned", revision: 2 },
  host: {
    hostId: "h1",
    runtimeConfig: { agentLoop: "claude-code" },
  },
  servers: { effectiveServerIds: [] },
  skills: [ordinary, plugin],
  serverSkills: [
    {
      serverSkillId: "s3",
      ref: "srv/search",
      description: "Search",
      name: "search",
      files: [],
      versionHash: "hash",
    },
  ],
  pluginVersions: [pin],
};
function serve(environment: object = spec) {
  query.mockImplementation(async (ref: string) => {
    if (ref === "projectEnvironments:resolveEnvironmentForRuntime")
      return environment;
    if (ref === "plugins:resolvePluginRuntimePreview")
      return {
        serverComponents: [],
        pluginVersions: [pin],
        pluginSkills: [
          {
            materializedSkillId: "s2",
            modelRef: "plugin/docs",
            pluginVersionId: "v1",
          },
        ],
      };
    if (
      ref === "projectSkills:listSkills" ||
      ref === "projectSkills:listSkillsForRuntime"
    ) {
      return [ordinary, skill("s4", "docs", []), skill("s5", "personal", [])];
    }
    throw new Error("Unexpected query: " + ref);
  });
}
const named = { kind: "environment", environmentId: "env1" };
const bare = { kind: "client", hostId: "h1" };
const url = "/api/web/environments/skills-preview";
function preview(target: object, extras: object = {}) {
  const { app, token } = createWebTestApp();
  return postJson(
    app,
    url,
    { projectId: "project1", target, ...extras },
    token,
  );
}

describe("per-pane Skills preview", () => {
  beforeEach(() => {
    process.env.CONVEX_URL = "https://example.convex.cloud";
    vi.resetAllMocks();
    serve();
  });
  it.each([
    ["claude-code", 2, "server-skill-unsupported"],
    ["codex", 2, "server-skill-unsupported"],
    ["cursor", 0, "unsupported-harness"],
    [undefined, 3, null],
  ])(
    "predicts delivered count and capture support for %s",
    async (agentLoop, deliveredCount, reason) => {
      serve({ ...spec, host: { hostId: "h1", runtimeConfig: { agentLoop } } });
      const response = await preview(named);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.deliveredCount).toBe(deliveredCount);
      expect(data.skills[2]).toMatchObject({
        channels: ["mcp-server"],
        reason,
      });
      expect(JSON.stringify(data)).not.toMatch(
        /private instructions|signed-url|private.txt/,
      );
    },
  );
  it("applies the turn's plugin narrowing but keeps independently pinned skills", async () => {
    for (const [channels, expected] of [
      [["plugin"], "plugin-disabled"],
      [["host", "plugin"], null],
    ] as const) {
      serve({ ...spec, skills: [ordinary, { ...plugin, channels }] });
      const response = await preview(named, {
        pluginVersionIds: [],
        serverIds: [],
      });
      expect(response.status).toBe(200);
      expect((await response.json()).skills[1].reason).toBe(expected);
      expect(query).toHaveBeenCalledWith(
        "projectEnvironments:resolveEnvironmentForRuntime",
        expect.objectContaining({ serverOverrideIds: [] }),
      );
    }
  });
  it("reads an ordinary client's live skills without composing an environment", async () => {
    host.mockResolvedValue({ ok: true, config: {} });
    const response = await preview(bare);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deliveredCount: 3,
      skills: [
        { channels: ["project"] },
        { channels: ["project"] },
        { channels: ["project"] },
      ],
    });
    expect(query.mock.calls.map(([ref]) => ref)).toEqual([
      "projectSkills:listSkills",
    ]);
  });
  it("hides a project's existence on a bare native client's membership refusal", async () => {
    host.mockResolvedValue({ ok: true, config: { agentLoop: "codex" } });
    query.mockRejectedValue(
      new ConvexError({ code: "FORBIDDEN", message: "Access removed" }),
    );
    expect((await preview(bare)).status).toBe(404);
  });
  it("merges the native live pool with plugin pins by folder and deduplicates IDs", async () => {
    serve({ ...spec, environmentOrigin: "adhoc" });
    const response = await preview({ ...bare, environmentId: "env1" });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.deliveredCount).toBe(3);
    expect(data.skills).toHaveLength(5);
    expect(data.skills[3]).toMatchObject({
      skillId: "s4",
      reason: "name-collision",
    });
  });
  it("refuses to read another pane's live pool using a named setup or a mismatched client", async () => {
    expect((await preview({ ...bare, environmentId: "env1" })).status).toBe(
      409,
    );
    serve({ ...spec, environmentOrigin: "adhoc" });
    expect(
      (await preview({ ...bare, hostId: "other", environmentId: "env1" }))
        .status,
    ).toBe(409);
    expect(
      query.mock.calls.every(
        ([ref]) => ref === "projectEnvironments:resolveEnvironmentForRuntime",
      ),
    ).toBe(true);
  });
  it("requires authentication and refuses unknown plugin versions", async () => {
    expect(
      (
        await postJson(createWebTestApp().app, url, {
          projectId: "project1",
          target: named,
        })
      ).status,
    ).toBe(401);
    expect(
      (await preview(named, { pluginVersionIds: ["unrelated"] })).status,
    ).toBe(400);
  });
  /** Twelve long descriptions on MCPJam's agent, which overrun the prompt's
   *  skill list for a model of unknown size. */
  function serveManySkills() {
    const many = Array.from({ length: 12 }, (_, index) => ({
      ...skill(`many${index}`, `skill-${index}`, ["environment"]),
      description: "x".repeat(900),
    }));
    serve({
      ...spec,
      host: { hostId: "h1", runtimeConfig: {} },
      skills: many,
      serverSkills: [],
    });
  }
  it("marks a skill MCPJam's agent loads but leaves out of its prompt's list", async () => {
    serveManySkills();
    const data = await (await preview(named)).json();
    expect(data.deliveredCount).toBe(12);
    const unlisted = data.skills.filter(
      (row: { omittedFromCatalog?: boolean }) => row.omittedFromCatalog,
    );
    expect(unlisted.length).toBeGreaterThan(0);
    expect(
      unlisted.every((row: { reason: unknown }) => row.reason === null),
    ).toBe(true);
    expect(data.skills[0]).not.toHaveProperty("omittedFromCatalog");
  });
  it("sizes that list for the pane's model when the request names one", async () => {
    serveManySkills();
    const unlisted = async (extras: object) => {
      const data = await (await preview(named, extras)).json();
      return data.skills.filter(
        (row: { omittedFromCatalog?: boolean }) => row.omittedFromCatalog,
      ).length;
    };
    const unknownSize = await unlisted({});
    expect(await unlisted({ modelContextTokens: 1_000_000 })).toBe(0);
    expect(await unlisted({ modelContextTokens: 20_000 })).toBeGreaterThan(
      unknownSize,
    );
    expect((await preview(named, { modelContextTokens: 0 })).status).toBe(400);
  });
  it("shows the skills a scope left out, with the backend's reason", async () => {
    serve({
      ...spec,
      skillScopeExclusions: [
        {
          skillId: "s6",
          name: "extra",
          description: "More",
          reason: "over-cap",
        },
        {
          skillId: "s7",
          name: "research",
          description: "An older copy",
          reason: "name-collision",
        },
        // A reason this Inspector doesn't know is left off, not mislabeled.
        { skillId: "s8", name: "later", description: "", reason: "newer" },
      ],
    });
    const data = await (await preview(named)).json();
    expect(data.deliveredCount).toBe(2);
    expect(data.skills.slice(3)).toEqual([
      {
        skillId: "s6",
        name: "extra",
        description: "More",
        channels: ["project"],
        origin: { kind: "library" },
        reason: "over-cap",
      },
      {
        skillId: "s7",
        name: "research",
        description: "An older copy",
        channels: ["project"],
        origin: { kind: "library" },
        reason: "name-collision",
      },
    ]);
  });
  it("says where each skill comes from and which revision a turn loads", async () => {
    serve({
      ...spec,
      skills: [
        {
          ...ordinary,
          provenance: { projectSkillVersionNumber: 3, versionPinned: true },
        },
        { ...plugin, provenance: { projectSkillVersionNumber: 1 } },
      ],
      serverSkills: [
        { ...spec.serverSkills[0], serverLabel: "Search", versionNumber: 2 },
      ],
    });
    const response = await preview(named);
    expect(response.status).toBe(200);
    expect((await response.json()).skills).toEqual([
      expect.objectContaining({
        origin: { kind: "library" },
        version: { number: 3, pinned: true },
      }),
      expect.objectContaining({
        origin: { kind: "plugin" },
        version: { number: 1, pinned: false },
      }),
      expect.objectContaining({
        origin: { kind: "mcp-server", server: "Search" },
        version: { number: 2 },
      }),
    ]);
  });
});

describe("suite Skills preview", () => {
  const suiteUrl = "/api/web/environments/skills-preview/suite";
  const suitePreview = (body: object) => {
    const { app, token } = createWebTestApp();
    return postJson(app, suiteUrl, { projectId: "project1", ...body }, token);
  };
  const loops: Record<string, string> = {
    env1: "claude-code",
    env2: "cursor",
  };

  beforeEach(() => {
    process.env.CONVEX_URL = "https://example.convex.cloud";
    vi.resetAllMocks();
    serve();
    const answer = query.getMockImplementation()!;
    query.mockImplementation(
      async (ref: string, args: Record<string, unknown>) => {
        if (ref !== "projectEnvironments:resolveEnvironmentForRuntime")
          return answer(ref, args);
        const agentLoop = loops[String(args.environmentId)];
        if (!agentLoop) {
          throw new ConvexError({ code: "ENV_NOT_FOUND", message: "Gone" });
        }
        return {
          ...spec,
          host: { hostId: "h1", runtimeConfig: { agentLoop } },
        };
      },
    );
  });

  it("reads each environment as an eval run of it delivers, one entry each", async () => {
    const response = await suitePreview({
      environmentIds: ["env1", "env2", "env1", "gone"],
    });
    expect(response.status).toBe(200);
    const { environments } = await response.json();
    expect(
      environments.map(
        (entry: { environmentId: string }) => entry.environmentId,
      ),
    ).toEqual(["env1", "env2", "gone"]);
    // A run copies a captured server skill onto a harness's box, which the
    // Compare pane's live turn on the same environment leaves off.
    expect(environments[0]).toMatchObject({
      ok: true,
      preview: { deliveredCount: 3 },
    });
    expect(environments[0].preview.skills[2]).toMatchObject({
      channels: ["mcp-server"],
      reason: null,
    });
    expect(environments[1].preview).toMatchObject({ deliveredCount: 0 });
    expect(environments[2]).toEqual({
      environmentId: "gone",
      ok: false,
      error: { status: 404, message: "Environment not found" },
    });
    expect(JSON.stringify(environments)).not.toMatch(
      /private instructions|signed-url|private.txt/,
    );
    expect(query).not.toHaveBeenCalledWith(
      "projectSkills:listSkills",
      expect.anything(),
    );
  });

  it("shows the skills a scope left out of an eval run's environment", async () => {
    const answer = query.getMockImplementation()!;
    query.mockImplementation(
      async (ref: string, args: Record<string, unknown>) => {
        const result = await answer(ref, args);
        if (ref !== "projectEnvironments:resolveEnvironmentForRuntime")
          return result;
        return {
          ...result,
          skillScopeExclusions: [
            {
              skillId: "s6",
              name: "extra",
              description: "More",
              reason: "over-cap",
            },
          ],
        };
      },
    );
    const response = await suitePreview({ environmentIds: ["env1"] });
    const { preview: run } = (await response.json()).environments[0];
    expect(run.deliveredCount).toBe(3);
    expect(run.skills.at(-1)).toMatchObject({
      skillId: "s6",
      reason: "over-cap",
    });
  });

  it("requires sign-in and refuses an empty list or one over the cap", async () => {
    expect((await suitePreview({ environmentIds: [] })).status).toBe(400);
    expect(
      (
        await suitePreview({
          environmentIds: Array.from({ length: 51 }, (_, i) => `env${i}`),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postJson(createWebTestApp().app, suiteUrl, {
          projectId: "project1",
          environmentIds: ["env1"],
        })
      ).status,
    ).toBe(401);
  });
});
