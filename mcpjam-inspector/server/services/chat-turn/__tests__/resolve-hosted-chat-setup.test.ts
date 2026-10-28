import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { resolveHostedChatSetup } from "../resolve-hosted-chat-setup.js";
import { resolveChatTurn } from "../resolve-chat-turn.js";
import { fetchScenarioRuntimeConfig } from "../../../utils/scenario-runtime-config.js";
import { fetchHostRuntimeConfig } from "../../../utils/host-runtime-config.js";

vi.mock("../resolve-chat-turn.js", () => ({ resolveChatTurn: vi.fn() }));
vi.mock("../../../utils/host-runtime-config.js", () => ({
  fetchHostRuntimeConfig: vi.fn(),
}));
vi.mock("../../../utils/harness/harness-box.js", () => ({
  canProvisionHarnessBoxes: () => true,
}));
vi.mock("../../../utils/scenario-runtime-config.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/scenario-runtime-config.js")
  >()),
  fetchScenarioRuntimeConfig: vi.fn(),
}));
const client = new ConvexHttpClient("https://test.convex.cloud");
const common = {
  bearer: "test",
  projectId: "p",
  getClient: vi.fn(async () => client),
};
const runtimeConfig = {
  harness: "codex" as const,
  modelId: "openai/gpt-5",
  systemPrompt: "",
  temperature: 0.7,
  requireToolApproval: true,
  hostStyle: "codex",
};
const projectAccess = {
  kind: "project" as const,
  projectId: "p",
  guest: false,
  chatEnvironments: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hosted setup normalization", () => {
  it("keeps legacy host-backed scenarios on their grant resolver", async () => {
    vi.mocked(fetchScenarioRuntimeConfig).mockResolvedValue({
      ok: true,
      config: { ...runtimeConfig, scenarioId: "s", accessVersion: 4 },
    });
    const result = await resolveHostedChatSetup({
      ...common,
      target: { kind: "scenario", scenarioId: "s" },
      access: { kind: "scenario", scenarioId: "s", accessVersion: 4 },
    });
    expect(result).toMatchObject({
      mode: "recorded",
      hostRuntimeConfig: { harness: "codex" },
      environmentSpec: null,
      scenarioEnvironment: null,
    });
    expect(fetchScenarioRuntimeConfig).toHaveBeenCalledWith({
      scenarioId: "s",
      accessVersion: 4,
      bearer: "test",
      harnessBox: true,
    });
    expect(common.getClient).not.toHaveBeenCalled();
    expect(resolveChatTurn).not.toHaveBeenCalled();
  });
  it.each([
    ["SCENARIO_ACCESS_STALE", 409],
    ["SCENARIO_SIGN_IN_REQUIRED", 401],
    [undefined, 403],
  ] as const)("keeps scenario denial %s", async (code, status) => {
    vi.mocked(fetchScenarioRuntimeConfig).mockResolvedValue({
      ok: false,
      status,
      error: "denied",
      code,
    });
    await expect(
      resolveHostedChatSetup({
        ...common,
        target: { kind: "scenario", scenarioId: "s" },
        access: { kind: "scenario", scenarioId: "s", accessVersion: 4 },
      }),
    ).rejects.toMatchObject({ status });
    expect(resolveChatTurn).not.toHaveBeenCalled();
  });
  it("refuses a target/access mismatch before any backend call", async () => {
    await expect(
      resolveHostedChatSetup({
        ...common,
        target: { kind: "scenario", scenarioId: "s" },
        access: projectAccess,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(common.getClient).not.toHaveBeenCalled();
    expect(fetchScenarioRuntimeConfig).not.toHaveBeenCalled();
  });
  it("normalizes old-backend host chat without synthesizing a setup", async () => {
    vi.mocked(fetchHostRuntimeConfig).mockResolvedValue({
      ok: true,
      config: { ...runtimeConfig, hostId: "h" },
    });
    const result = await resolveHostedChatSetup({
      ...common,
      target: { kind: "host", hostId: "h" },
      access: { ...projectAccess, chatEnvironments: false },
    });
    expect(result).toMatchObject({
      mode: "interactive",
      hostRuntimeConfig: { harness: "codex" },
      environmentSpec: null,
    });
    expect(resolveChatTurn).not.toHaveBeenCalled();
  });
  it("normalizes project chat with the explicit empty override intact", async () => {
    const environment = {
      environmentRef: { environmentId: "e", name: "", revision: 1 },
      host: { hostId: "h", runtimeConfig: {} },
      servers: { effectiveServerIds: [] },
    };
    vi.mocked(resolveChatTurn).mockResolvedValue({
      kind: "project",
      mode: "interactive",
      access: projectAccess,
      environment,
      composed: true,
      selection: { kind: "explicit", serverIds: [] },
    });
    const result = await resolveHostedChatSetup({
      ...common,
      target: { kind: "host", hostId: "h" },
      access: projectAccess,
      selectedServerIds: [],
    });
    expect(result.environmentSpec).toBe(environment);
    expect(resolveChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: { kind: "explicit", serverIds: [] },
      }),
    );
  });
});
