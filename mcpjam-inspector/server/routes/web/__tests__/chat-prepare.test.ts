import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  setup: vi.fn(),
  turnAuthorization: vi.fn(),
  prepare: vi.fn(),
  selectsMaterialized: vi.fn(),
  canProvision: vi.fn(),
  credentialRefusal: vi.fn(),
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
vi.mock("../../../utils/harness/playground-box.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  playgroundCredentialRefusal: mocks.credentialRefusal,
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
  mocks.setup.mockResolvedValue(setupValue());
  mocks.turnAuthorization.mockResolvedValue(undefined);
  mocks.prepare.mockResolvedValue({ outcome: "prepared" });
  mocks.selectsMaterialized.mockResolvedValue(false);
  mocks.canProvision.mockReturnValue(true);
  mocks.credentialRefusal.mockResolvedValue(null);
});

describe("POST /api/web/chat/prepare", () => {
  it("asks the backend nothing for a member without an organization", async () => {
    mocks.setup.mockResolvedValue(
      setupValue({ authorizedOrganizationId: undefined }),
    );
    const res = await post();
    expect(await res.json()).toEqual({
      outcome: "skipped",
      reason: "disabled",
    });
    expect(mocks.turnAuthorization).not.toHaveBeenCalled();
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

  it.each(["codex", "copilot-cli", "opencode"])(
    "prepares a %s chat's box the same way",
    async (harness) => {
      mocks.setup.mockResolvedValue(
        setupValue({ resolvedExecution: { harness } }),
      );
      expect(await (await post()).json()).toEqual({ outcome: "prepared" });
      expect(mocks.prepare.mock.calls[0]![0]).toMatchObject({
        harnessId: harness,
        chatSessionId: "chat_1",
      });
      expect(mocks.credentialRefusal).not.toHaveBeenCalled();
    },
  );

  it("checks a Cursor CLI chat's organization key first, and boots its box with the turn environment's grant, as the Send does", async () => {
    mocks.setup.mockResolvedValue(
      setupValue({ resolvedExecution: { harness: "cursor" } }),
    );
    expect(await (await post()).json()).toEqual({ outcome: "prepared" });
    expect(mocks.credentialRefusal).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessId: "cursor",
        bearer: "member",
        projectId: "project_1",
      }),
    );
    expect(mocks.prepare.mock.calls[0]![0]).toMatchObject({
      harnessId: "cursor",
      projectEnvironmentId: "env_1",
    });
  });

  it("boots nothing for a Cursor CLI chat whose organization has no key ready", async () => {
    mocks.setup.mockResolvedValue(
      setupValue({ resolvedExecution: { harness: "cursor" } }),
    );
    mocks.credentialRefusal.mockResolvedValue(
      "Ask an org admin to add a Cursor key in Organization → AI providers.",
    );
    expect(await (await post()).json()).toEqual({
      outcome: "skipped",
      reason: "not_eligible",
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown runtime", { resolvedExecution: { harness: "not-a-harness" } }],
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
    [
      "a Cursor CLI compare column",
      {
        resolvedExecution: { harness: "cursor" },
        hostedBody: {
          projectId: "project_1",
          chatSessionId: "chat_1",
          comparePane: true,
        },
      },
    ],
    ["no conversation", { hostedBody: { projectId: "project_1" } }],
    // The vendor's own app runs a web client's turn: no box to prepare.
    ["a Claude web chat", { resolvedExecution: { harness: "claude-web" } }],
    ["a ChatGPT web chat", { resolvedExecution: { harness: "chatgpt-web" } }],
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
