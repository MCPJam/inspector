import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { resolveHostedChatSetup } from "../resolve-hosted-chat-setup.js";
import { resolveChatTurn } from "../resolve-chat-turn.js";
import { fetchScenarioRuntimeConfig } from "../../../utils/scenario-runtime-config.js";

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
  vi.spyOn(client, "query").mockResolvedValue(null);
  vi.mocked(resolveChatTurn).mockResolvedValue({
    kind: "project", mode: "interactive", composed: true,
    access: { kind: "project", projectId: "p" },
    selection: { kind: "explicit", serverIds: [] },
    environment: {
      environmentRef: { environmentId: "e", name: "", revision: 1 },
      host: { hostId: "h", runtimeConfig: {} },
      servers: { effectiveServerIds: [] },
    },
  });
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
  it.each(["host", "adhoc", "environment"] as const)(
    "requires shared setup support for %s turns",
    async (kind) => {
      const target =
        kind === "host"
          ? { kind, hostId: "h" }
          : kind === "environment"
            ? { kind, environmentId: "e" }
            : { kind, projectId: "p" };
      await expect(
        resolveHostedChatSetup({
          ...common,
          target,
          access: { ...projectAccess, chatEnvironments: false },
        }),
      ).rejects.toMatchObject({ status: 422 });
      expect(resolveChatTurn).not.toHaveBeenCalled();
    },
  );
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
  it.each(["adhoc", "host", "environment"] as const)(
    "normalizes %s policy without changing skill or sandbox ownership",
    async (kind) => {
      const query = vi.spyOn(client, "query").mockResolvedValue({
        builtInToolIds: ["list_projects"],
        requireToolApproval: false,
      });
      const target =
        kind === "host"
          ? { kind, hostId: "h" }
          : kind === "environment"
            ? { kind, environmentId: "e" }
            : { kind, projectId: "p" };
      vi.mocked(resolveChatTurn).mockResolvedValue({
        kind: "project",
        mode: "interactive",
        composed: true,
        access: { kind: "project", projectId: "p" },
        selection: { kind: "explicit", serverIds: [] },
        environment: {
          environmentRef: { environmentId: "e", name: "", revision: 1 },
          host: { hostId: "h", runtimeConfig: { builtInToolIds: ["bash"] } },
          servers: { effectiveServerIds: [] },
        },
      });
      const result = await resolveHostedChatSetup({
        ...common,
        target,
        access: projectAccess,
      });
      // A client's turn (no environment of its own named) asks the backend
      // for the client's skill selection as a scope.
      expect(result.clientTurn).toBe(kind !== "environment");
      expect(resolveChatTurn).toHaveBeenLastCalledWith(
        expect.objectContaining(
          kind === "environment" ? {} : { skillScope: "visible" },
        ),
      );
      if (kind === "environment") {
        expect(
          vi.mocked(resolveChatTurn).mock.lastCall?.[0],
        ).not.toHaveProperty("skillScope");
      }
      expect(result.authoritativeConnectionPolicy).toBe(kind !== "adhoc");
      expect(result.pinsEnvironment).toBe(kind === "environment");
      expect(result.workspaceToolsBarred).toBe(false);
      expect(result.toolConfiguration?.builtInToolIds).toEqual(
        kind === "adhoc" ? ["list_projects"] : ["bash"],
      );
      expect(query).toHaveBeenCalledTimes(kind === "adhoc" ? 1 : 0);
    },
  );
  it("withholds workspace tools when the project default cannot be read", async () => {
    vi.spyOn(client, "query").mockRejectedValue(new Error("unavailable"));
    const result = await resolveHostedChatSetup({
      ...common,
      target: { kind: "adhoc", projectId: "p" },
      access: projectAccess,
    });
    expect(result.toolConfigurationUnavailable).toBe(true);
    expect(result.toolConfiguration).toBeNull();
  });
  it.each([
    ["an ad-hoc row", "adhoc", true],
    ["a named row", "named", false],
    ["a row of unknown origin", undefined, false],
  ] as const)(
    "asks for a hidden environment's scope, and treats %s as a client's turn only when ad hoc",
    async (_label, origin, clientTurn) => {
      vi.mocked(resolveChatTurn).mockResolvedValue({
        kind: "project",
        mode: "interactive",
        composed: false,
        access: { kind: "project", projectId: "p" },
        selection: { kind: "environment-default" },
        environment: {
          environmentRef: { environmentId: "e", name: "Chat", revision: 1 },
          ...(origin ? { environmentOrigin: origin } : {}),
          host: { hostId: "h", runtimeConfig: {} },
          servers: { effectiveServerIds: [] },
        },
      });
      const result = await resolveHostedChatSetup({
        ...common,
        target: { kind: "environment", environmentId: "e" },
        access: projectAccess,
        hiddenEnvironment: true,
      });
      expect(resolveChatTurn).toHaveBeenLastCalledWith(
        expect.objectContaining({ skillScope: "visible" }),
      );
      expect(result.clientTurn).toBe(clientTurn);
    },
  );
  it("reports the skills a pane's plugin narrowing switched off", async () => {
    const skill = (skillId: string, name: string) => ({
      skillId,
      name,
      description: "",
      content: "",
      aggregateHash: `agg_${skillId}`,
    });
    vi.mocked(resolveChatTurn).mockResolvedValue({
      kind: "project",
      mode: "interactive",
      composed: false,
      access: { kind: "project", projectId: "p" },
      selection: { kind: "environment-default" },
      environment: {
        environmentRef: { environmentId: "e", name: "Env", revision: 1 },
        host: { hostId: "h", runtimeConfig: {} },
        servers: { effectiveServerIds: [] },
        skills: [skill("sk_kept", "kept"), skill("sk_plugin", "dropped")],
        pluginVersions: [
          { pluginId: "pl", pluginVersionId: "pv_1", name: "p" },
        ],
      },
    });
    vi.spyOn(client, "query").mockResolvedValue({
      pluginVersions: [{ pluginId: "pl", pluginVersionId: "pv_1", name: "p" }],
      effectiveServerIds: [],
      serverComponents: [],
      pluginSkills: [
        {
          pluginVersionId: "pv_1",
          materializedSkillId: "sk_plugin",
          modelRef: "p/dropped",
        },
      ],
      unavailableComponents: [],
    });
    const result = await resolveHostedChatSetup({
      ...common,
      target: {
        kind: "environment",
        environmentId: "e",
        overrides: { pluginVersionIds: [] },
      },
      access: projectAccess,
    });
    expect(result.environmentSpec?.skills?.map((s) => s.skillId)).toEqual([
      "sk_kept",
    ]);
    expect(result.pluginDisabled.map((s) => s.skillId)).toEqual(["sk_plugin"]);
  });
  it("reads an environment-backed study's captured server skills", async () => {
    vi.mocked(fetchScenarioRuntimeConfig).mockResolvedValue({
      ok: true,
      config: {
        ...runtimeConfig,
        scenarioId: "s",
        accessVersion: 4,
        environment: {
          environmentRef: { environmentId: "e", name: "Study", revision: 2 },
          servers: { effectiveServerIds: ["srv_1"] },
          serverSkills: [
            {
              serverSkillId: "ss_1",
              versionId: "ssv_1",
              serverId: "srv_1",
              serverSlug: "acme",
              serverLabel: "Acme",
              ref: "acme/refunds",
              skillUri: "skill://acme/refunds",
              name: "refunds",
              description: "Handle refunds",
              content: "# Refunds",
              contentSha256: "sha",
              versionHash: "vh",
              versionNumber: 1,
              capturedAt: 1,
              files: [],
            },
            { serverSkillId: "ss_torn" },
          ],
        },
      } as never,
    });
    const result = await resolveHostedChatSetup({
      ...common,
      target: { kind: "scenario", scenarioId: "s" },
      access: { kind: "scenario", scenarioId: "s", accessVersion: 4 },
    });
    // A torn entry is dropped, not the study's turn.
    expect(result.scenarioEnvironment?.serverSkills.map((s) => s.ref)).toEqual([
      "acme/refunds",
    ]);
    expect(
      result.effectiveCapabilities?.serverSkills.map((s) => s.ref),
    ).toEqual(["acme/refunds"]);
    expect(result.clientTurn).toBe(false);
  });
  it("does not read private project defaults for guests", async () => {
    const query = vi.spyOn(client, "query");
    const result = await resolveHostedChatSetup({
      ...common,
      target: { kind: "adhoc", projectId: "p" },
      access: { ...projectAccess, guest: true },
    });
    expect(result.workspaceToolsBarred).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });
});
