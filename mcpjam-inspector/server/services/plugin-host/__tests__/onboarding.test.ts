import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ read: vi.fn(), query: vi.fn() }));
vi.mock("../admission.js", () => ({ readPluginExecutionContext: f.read }));
vi.mock("../../evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: f.query }),
}));
import { readServerOnboarding } from "../onboarding";
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
