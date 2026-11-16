import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  setup: vi.fn(),
  turnAuthorization: vi.fn(),
  prepare: vi.fn(),
  selectsMaterialized: vi.fn(),
  canProvision: vi.fn(),
}));

vi.mock("../../../services/chat-turn/managed-setup.js", () => ({
  resolveManagedTurnSetup: mocks.setup,
}));
vi.mock("../../../services/chat-turn/turn-authorization.js", () => ({
  prepareTurnAuthorization: mocks.turnAuthorization,
}));
vi.mock(
  "../../../utils/harness/prepare-conversation-box.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    prepareConversationBox: mocks.prepare,
  }),
);
vi.mock("../../../utils/harness/environment-secret-delivery.js", () => ({
  environmentSelectsSecretDelivery: mocks.selectsMaterialized,
}));
vi.mock("../../../utils/harness/harness-box.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  canProvisionHarnessBoxes: mocks.canProvision,
}));

import chatPrepare from "../chat-prepare.js";

const app = new Hono().route("/api/web/chat", chatPrepare);

function post(body: Record<string, unknown> = { projectId: "project_1" }) {
  return app.request("/api/web/chat/prepare", {
    method: "POST",
    headers: {
      authorization: "Bearer member",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** A new chat on a hosted Claude Code client, as the turn's setup resolves it. */
function setupValue(overrides: Record<string, unknown> = {}) {
  return {
    value: {
      authorizedOrganizationId: "org_1",
      hostedBody: { projectId: "project_1", chatSessionId: "chat_1" },
      resolvedExecution: { harness: "claude-code" },
      turnMode: "interactive",
      harnessExecutionTarget: undefined,
      environmentSpec: { environmentRef: { environmentId: "env_1" } },
      pinsEnvironment: false,
      executionTarget: { kind: "host", hostId: "host_1" },
      modelDefinition: {
        id: "anthropic/claude-haiku-4.5",
        provider: "anthropic",
      },
      routingSelection: undefined,
      ...overrides,
    },
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.stubEnv("MCPJAM_HARNESS_PREPARE_BOX", "true");
  vi.stubEnv("MCPJAM_HARNESS_PREPARE_BOX_ORG_IDS", undefined);
  mocks.setup.mockResolvedValue(setupValue());
  mocks.turnAuthorization.mockResolvedValue(undefined);
  mocks.prepare.mockResolvedValue({ outcome: "prepared" });
  mocks.selectsMaterialized.mockResolvedValue(false);
  mocks.canProvision.mockReturnValue(true);
});

afterEach(() => vi.unstubAllEnvs());

describe("POST /api/web/chat/prepare", () => {
  it("with the switch off, asks the backend nothing", async () => {
    vi.stubEnv("MCPJAM_HARNESS_PREPARE_BOX", undefined);
    const res = await post();
    expect(await res.json()).toEqual({
      outcome: "skipped",
      reason: "disabled",
    });
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("prepares nothing for an organization off the list", async () => {
    vi.stubEnv("MCPJAM_HARNESS_PREPARE_BOX_ORG_IDS", "org_other");
    const res = await post();
    expect(await res.json()).toEqual({
      outcome: "skipped",
      reason: "disabled",
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("runs the turn's setup with no message, then prepares the conversation's box", async () => {
    const res = await post({
      projectId: "project_1",
      messages: [{ role: "user" }],
    });
    expect(await res.json()).toEqual({ outcome: "prepared" });
    expect(mocks.setup).toHaveBeenCalledWith(
      expect.objectContaining({
        preparation: true,
        localIngress: false,
        bearerToken: "member",
        rawBody: expect.objectContaining({ messages: [] }),
      }),
    );
    expect(mocks.turnAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: "project_1",
        chatSessionId: "chat_1",
        harness: "claude-code",
      }),
      expect.anything(),
    );
    const args = mocks.prepare.mock.calls[0]![0];
    expect(args).toMatchObject({
      harnessId: "claude-code",
      projectId: "project_1",
      chatSessionId: "chat_1",
      modelId: "anthropic/claude-haiku-4.5",
      bearer: "member",
    });
    // A client's box carries no environment grant, as the Send's would not.
    expect(args.projectEnvironmentId).toBeUndefined();
    await expect(args.authorization()).resolves.toBe("Bearer member");
  });

  it("boots an environment chat's box with the environment's grant", async () => {
    mocks.setup.mockResolvedValue(
      setupValue({
        pinsEnvironment: true,
        executionTarget: { kind: "environment", environmentId: "env_1" },
      }),
    );
    await post();
    expect(mocks.prepare.mock.calls[0]![0].projectEnvironmentId).toBe("env_1");
  });

  it.each([
    ["another client", { resolvedExecution: { harness: "cursor" } }],
    ["no harness", { resolvedExecution: { harness: undefined } }],
    ["a local runtime", { harnessExecutionTarget: { kind: "local" } }],
    ["a study", { turnMode: "recorded" }],
    [
      "a compare column",
      {
        hostedBody: {
          projectId: "project_1",
          chatSessionId: "chat_1",
          comparePane: true,
        },
      },
    ],
    ["no conversation", { hostedBody: { projectId: "project_1" } }],
  ])("skips %s", async (_name, overrides) => {
    mocks.setup.mockResolvedValue(setupValue(overrides));
    const res = await post();
    expect(await res.json()).toEqual({
      outcome: "skipped",
      reason: "not_eligible",
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("skips a chat whose Send would hand the box plaintext secrets", async () => {
    mocks.selectsMaterialized.mockResolvedValue(true);
    const res = await post();
    expect(await res.json()).toEqual({
      outcome: "skipped",
      reason: "materialized_secrets",
    });
    expect(mocks.selectsMaterialized).toHaveBeenCalledWith(
      "member",
      { projectId: "project_1", environmentId: "env_1" },
      "materialized",
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("skips on a server that cannot run boxes", async () => {
    mocks.canProvision.mockReturnValue(false);
    const res = await post();
    expect(await res.json()).toEqual({
      outcome: "skipped",
      reason: "not_eligible",
    });
  });
});
