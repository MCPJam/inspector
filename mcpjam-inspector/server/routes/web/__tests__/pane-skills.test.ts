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
});
