import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const m = vi.hoisted(() => ({
  hostedSetup: vi.fn(),
  ensure: vi.fn(),
  useLocalHarness: vi.fn(),
  localSkills: vi.fn(),
}));
vi.mock("../resolve-hosted-chat-setup.js", () => ({
  resolveHostedChatSetup: m.hostedSetup,
}));
vi.mock("../../../routes/web/auth.js", async (original) => ({
  ...(await original<typeof import("../../../routes/web/auth.js")>()),
  authorizeProject: async () => ({ chatEnvironments: false }),
}));
vi.mock("../../../utils/built-in-tools/built-in-tool-policy.js", () => ({
  resolveTurnBuiltInToolIds: async () => ({ ids: [], dropped: [] }),
}));
vi.mock("../../../utils/harness/local/run-resources.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/harness/local/run-resources.js")
  >()),
  shouldUseLocalHarness: m.useLocalHarness,
}));
vi.mock("../../../utils/harness/local/readiness.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/harness/local/readiness.js")
  >()),
  ensureLocalHarnessTarget: m.ensure,
}));
vi.mock("../../../utils/harness/harness-availability.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/harness/harness-availability.js")
  >()),
  checkHarnessRuntimeAvailable: () => ({ ok: true }),
  externalAccountHostModelRefusalReason: () => undefined,
}));
vi.mock("../../../utils/computers/cloud-skill-tools.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/computers/cloud-skill-tools.js")
  >()),
  listCloudRuntimeSkills: async () => [],
}));
vi.mock("../../../utils/skill-tools.js", async (original) => ({
  ...(await original<typeof import("../../../utils/skill-tools.js")>()),
  listLocalRuntimeSkills: m.localSkills,
}));
import { resolveManagedTurnSetup } from "../managed-setup.js";
import { LocalAutoApproveConsentRequiredError } from "../../../utils/harness/local/readiness.js";
import { createHostedRpcLogCollector } from "../../../routes/web/hosted-rpc-logs.js";

const baseBody = {
  projectId: "project-1",
  selectedServerIds: [],
  messages: [{ role: "user", content: "hi" }],
  model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
};
function hostedSetup(
  mode: "interactive" | "recorded",
  hostRuntimeConfig: Record<string, unknown> = {},
) {
  return {
    mode,
    hostRuntimeConfig,
    environmentSpec: null,
    scenarioEnvironment: null,
    effectiveCapabilities: null,
    usesLiveSkills: true,
    authoritativeConnectionPolicy: mode === "recorded",
    pinsEnvironment: false,
    authoritativeCapabilities: mode === "recorded",
    toolConfiguration: null,
    toolConfigurationUnavailable: false,
    workspaceToolsBarred: false,
  };
}
async function resolveSetup(rawBody: Record<string, unknown>) {
  let setup: Awaited<ReturnType<typeof resolveManagedTurnSetup>> | undefined;
  const app = new Hono();
  app.post("/", async (c) => {
    setup = await resolveManagedTurnSetup({
      c,
      rawBody: { ...baseBody, ...rawBody },
      bearerToken: "bearer",
      localIngress: true,
      rpcCollector: createHostedRpcLogCollector({}),
    });
    return setup.response ?? c.json({});
  });
  const response = await app.request("/", { method: "POST" });
  return { response, setup: setup! };
}

describe("managed setup local runtime policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.useLocalHarness.mockResolvedValue(false);
    m.localSkills.mockResolvedValue([
      { ref: "machine-skill", skillId: "local:machine-skill" },
    ]);
  });

  it("checks auto-approve consent before a local Claude Code turn starts", async () => {
    m.hostedSetup.mockResolvedValue(
      hostedSetup("interactive", { harness: "claude-code" }),
    );
    m.useLocalHarness.mockResolvedValue(true);
    m.ensure.mockRejectedValue(new LocalAutoApproveConsentRequiredError());
    const { response } = await resolveSetup({ requireToolApproval: false });
    expect(m.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ requireToolApproval: false }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: new LocalAutoApproveConsentRequiredError().message,
      status: "auto-approve-consent-required",
    });
  });

  it("gives an interactive turn this machine's skills", async () => {
    m.hostedSetup.mockResolvedValue(hostedSetup("interactive"));
    const { setup } = await resolveSetup({});
    expect(m.localSkills).toHaveBeenCalled();
    expect(setup.value?.liveProjectCapabilities?.localSkills).toEqual([
      expect.objectContaining({ ref: "machine-skill" }),
    ]);
  });

  it("never gives a recorded scenario turn this machine's skills", async () => {
    m.hostedSetup.mockResolvedValue(hostedSetup("recorded"));
    const { setup } = await resolveSetup({
      scenarioId: "scenario-1",
      accessVersion: 1,
    });
    expect(setup.value?.turnMode).toBe("recorded");
    expect(m.localSkills).not.toHaveBeenCalled();
    expect(setup.value?.liveProjectCapabilities?.localSkills ?? []).toEqual(
      [],
    );
  });
});
