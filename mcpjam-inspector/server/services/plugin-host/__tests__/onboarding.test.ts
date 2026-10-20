import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ read: vi.fn(), query: vi.fn() }));
vi.mock("../admission.js", () => ({ readPluginExecutionContext: f.read }));
vi.mock("../../evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: f.query }),
}));
import {
  onboardingRequestSchema,
  readOnboarding,
  readPluginOnboarding,
  readServerOnboarding,
} from "../onboarding";
const identity = {
  kind: "plugin",
  serverId: "s",
  pluginId: "p",
  pluginVersionId: "v",
  bundleHash: "hash",
  componentKey: "c",
};
const spec = {
  pluginId: "p",
  pluginVersionId: "v",
  name: "Fixture",
  bundleHash: "hash",
  onboarding: {
    componentId: "c",
    modelRef: "p/setup",
    materializedSkillId: "skill",
  },
  skill: {
    skillId: "skill",
    name: "setup",
    description: "fixture",
    content: "Safe disposable setup",
    contentHash: "content",
  },
  files: [],
};
const args = {
  actorId: "a",
  projectId: "project",
  hostId: "host",
  serverId: "s",
  bearer: "synthetic",
  signal: new AbortController().signal,
  content: true,
};
beforeEach(() => {
  vi.resetAllMocks();
  f.read.mockResolvedValue({
    serverBindings: new Map([["s", identity]]),
    hostConfig: { hostId: "host" },
  });
  f.query
    .mockResolvedValueOnce({ onboarding: spec.onboarding })
    .mockResolvedValueOnce(spec);
});
describe("original server onboarding", () => {
  it("returns exact packaged content after fresh authority and never executes", async () => {
    expect(await readServerOnboarding(args)).toEqual({ available: true, spec });
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it("checks availability without loading or running skill content", async () => {
    expect(await readServerOnboarding({ ...args, content: false })).toEqual({
      available: true,
    });
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("does not invent onboarding for ordinary servers", async () => {
    f.read.mockResolvedValue({
      serverBindings: new Map([["s", { kind: "standalone", serverId: "s" }]]),
    });
    expect(await readServerOnboarding(args)).toEqual({ available: false });
    expect(f.query).not.toHaveBeenCalled();
  });
  it("refuses changes during content reads", async () => {
    f.read
      .mockResolvedValueOnce({
        serverBindings: new Map([["s", identity]]),
        hostConfig: { hostId: "host" },
      })
      .mockResolvedValueOnce({
        serverBindings: new Map([
          ["s", { ...identity, pluginVersionId: "new" }],
        ]),
        hostConfig: { hostId: "host" },
      });
    await expect(readServerOnboarding(args)).rejects.toThrow(
      "INSTANCE_ONBOARDING_CHANGED",
    );
  });
  it("refuses content from another immutable version", async () => {
    f.query
      .mockReset()
      .mockResolvedValueOnce({ onboarding: spec.onboarding })
      .mockResolvedValueOnce({ ...spec, pluginVersionId: "other" });
    await expect(readServerOnboarding(args)).rejects.toThrow(
      "INSTANCE_ONBOARDING_CHANGED",
    );
  });
});

describe("onboarding for a plugin with no server", () => {
  const skillsOnly = (overrides: Record<string, unknown> = {}) => ({
    enabled: true,
    plugins: [
      {
        pluginId: "p",
        pluginVersionId: "v",
        status: "active",
        servers: [],
        ...overrides,
      },
    ],
  });
  const pluginArgs = {
    projectId: "project",
    pluginId: "p",
    bearer: "synthetic",
    signal: new AbortController().signal,
    content: true,
  };
  beforeEach(() => {
    f.query.mockReset();
  });
  const answer = (...replies: unknown[]) => {
    for (const reply of replies) f.query.mockResolvedValueOnce(reply);
  };

  it("resolves the version this member's next turn runs, then reads it twice", async () => {
    answer(skillsOnly(), { onboarding: spec.onboarding }, spec, skillsOnly());
    expect(await readPluginOnboarding(pluginArgs)).toEqual({
      available: true,
      spec,
    });
    expect(f.query.mock.calls.map((call) => call[1])).toEqual([
      { projectId: "project", content: false },
      { pluginVersionId: "v" },
      { projectId: "project", pluginVersionId: "v" },
      { projectId: "project", content: false },
    ]);
    expect(f.read).not.toHaveBeenCalled();
  });

  it("checks availability without loading skill content", async () => {
    answer(skillsOnly(), { onboarding: spec.onboarding }, skillsOnly());
    expect(
      await readPluginOnboarding({ ...pluginArgs, content: false }),
    ).toEqual({ available: true });
    expect(f.query).toHaveBeenCalledTimes(3);
  });

  it("leaves a plugin with servers to them, and an inactive one out", async () => {
    for (const reply of [
      skillsOnly({ servers: [{ serverId: "s" }] }),
      skillsOnly({ status: "skipped", reason: "disabled" }),
      skillsOnly({ pluginVersionId: null }),
      { enabled: false },
    ]) {
      f.query.mockReset();
      answer(reply);
      expect(await readPluginOnboarding(pluginArgs)).toEqual({
        available: false,
      });
      expect(f.query).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a version that changed during the read, or another plugin's content", async () => {
    answer(
      skillsOnly(),
      { onboarding: spec.onboarding },
      spec,
      skillsOnly({ pluginVersionId: "newer" }),
    );
    await expect(readPluginOnboarding(pluginArgs)).rejects.toThrow(
      "INSTANCE_ONBOARDING_CHANGED",
    );
    f.query.mockReset();
    answer(
      skillsOnly(),
      { onboarding: spec.onboarding },
      { ...spec, pluginId: "other" },
      skillsOnly(),
    );
    await expect(readPluginOnboarding(pluginArgs)).rejects.toThrow(
      "INSTANCE_ONBOARDING_CHANGED",
    );
  });

  it("takes a server or a plugin, never both or neither", async () => {
    const base = { projectId: "project", pluginWorkspace: {}, content: false };
    expect(
      onboardingRequestSchema.safeParse({ ...base, hostId: "h", serverId: "s" })
        .success,
    ).toBe(true);
    expect(
      onboardingRequestSchema.safeParse({ ...base, pluginId: "p" }).success,
    ).toBe(true);
    expect(
      onboardingRequestSchema.safeParse({
        ...base,
        hostId: "h",
        serverId: "s",
        pluginId: "p",
      }).success,
    ).toBe(false);
    expect(onboardingRequestSchema.safeParse(base).success).toBe(false);

    answer(skillsOnly(), { onboarding: spec.onboarding }, skillsOnly());
    expect(
      await readOnboarding(
        { ...base, pluginId: "p" },
        { actorId: "a" },
        "synthetic",
        new AbortController().signal,
      ),
    ).toEqual({ available: true });
    expect(f.read).not.toHaveBeenCalled();
  });
});
