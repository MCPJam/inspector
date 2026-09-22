/**
 * MJ-013 regression: a guest's `projectId` must not reach project-scoped work.
 *
 * `POST /api/web/chat-v2` accepted any string in `projectId` — a foreign
 * tenant's project, or one that does not exist — and still ran the hosted model
 * call, so an anonymous session could bill credits against someone else's
 * project. The same guest token is refused with `403 Not a member of this
 * project` on the MCP routes, which is the behaviour chat has to agree with.
 *
 * The turn itself still runs: guest chat is a product feature, and the fix is
 * that it runs without a project, not that it stops running.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  fetchHostRuntimeConfigMock,
  checkHarnessRuntimeAvailableMock,
  resolveHostToolsMock,
  listCloudRuntimeSkillsMock,
  listLocalRuntimeSkillsMock,
  validateGuestTokenMock,
  validateAppToolEntriesMock,
  validateUiToolEntriesMock,
  validatePageToolEntriesMock,
  validateWidgetModelContextEntriesMock,
  buildWidgetModelContextSystemPromptMock,
  AppToolValidationErrorMock,
  UiToolValidationErrorMock,
  PageToolValidationErrorMock,
  WidgetModelContextValidationErrorMock,
} = vi.hoisted(() => ({
  prepareChatV2Mock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  fetchHostRuntimeConfigMock: vi.fn(),
  checkHarnessRuntimeAvailableMock: vi.fn(),
  resolveHostToolsMock: vi.fn(() => ({})),
  listCloudRuntimeSkillsMock: vi.fn(),
  listLocalRuntimeSkillsMock: vi.fn(),
  validateGuestTokenMock: vi.fn(),
  validateAppToolEntriesMock: vi.fn(() => []),
  validateUiToolEntriesMock: vi.fn(() => []),
  validatePageToolEntriesMock: vi.fn(() => []),
  validateWidgetModelContextEntriesMock: vi.fn(() => []),
  buildWidgetModelContextSystemPromptMock: vi.fn(() => ""),
  AppToolValidationErrorMock: class AppToolValidationError extends Error {},
  UiToolValidationErrorMock: class UiToolValidationError extends Error {},
  PageToolValidationErrorMock: class PageToolValidationError extends Error {},
  WidgetModelContextValidationErrorMock: class WidgetModelContextValidationError extends Error {},
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    convertToModelMessages: vi.fn((messages) => messages),
  };
});

vi.mock("@/shared/types", async () => {
  const actual =
    await vi.importActual<typeof import("@/shared/types")>("@/shared/types");
  return {
    ...actual,
    isMCPJamProvidedModel: vi.fn().mockReturnValue(true),
    isMCPJamGuestAllowedModel: vi.fn().mockReturnValue(true),
  };
});

vi.mock("../../../utils/chat-v2-orchestration", () => ({
  prepareChatV2: prepareChatV2Mock,
  validateAppToolEntries: validateAppToolEntriesMock,
  AppToolValidationError: AppToolValidationErrorMock,
  validateUiToolEntries: validateUiToolEntriesMock,
  UiToolValidationError: UiToolValidationErrorMock,
  validatePageToolEntries: validatePageToolEntriesMock,
  PageToolValidationError: PageToolValidationErrorMock,
  validateWidgetModelContextEntries: validateWidgetModelContextEntriesMock,
  buildWidgetModelContextSystemPrompt: buildWidgetModelContextSystemPromptMock,
  WidgetModelContextValidationError: WidgetModelContextValidationErrorMock,
}));

vi.mock("../../../utils/mcpjam-stream-handler", () => ({
  handleMCPJamFreeChatModel: handleMCPJamFreeChatModelMock,
  warnIfChatAbortSignalMissing: () => {},
}));

vi.mock("../../../utils/host-runtime-config.js", () => ({
  fetchHostRuntimeConfig: fetchHostRuntimeConfigMock,
}));

vi.mock("../../../utils/harness/harness-availability.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/harness/harness-availability.js")
  >("../../../utils/harness/harness-availability.js");
  return {
    ...actual,
    checkHarnessRuntimeAvailable: checkHarnessRuntimeAvailableMock,
  };
});

vi.mock("../../../utils/built-in-tools/registry.js", () => ({
  resolveHostTools: resolveHostToolsMock,
}));

vi.mock("../../../utils/computers/cloud-skill-tools.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/computers/cloud-skill-tools.js")
  >("../../../utils/computers/cloud-skill-tools.js");
  return { ...actual, listCloudRuntimeSkills: listCloudRuntimeSkillsMock };
});

vi.mock("../../../utils/skill-tools.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../utils/skill-tools.js")>(
      "../../../utils/skill-tools.js",
    );
  return { ...actual, listLocalRuntimeSkills: listLocalRuntimeSkillsMock };
});

vi.mock("../../../services/guest-token-verifier.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/guest-token-verifier.js")
  >("../../../services/guest-token-verifier.js");
  return { ...actual, validateGuestToken: validateGuestTokenMock };
});

import chatV2 from "../chat-v2.js";

const GUEST_BEARER = "guest-session-token";
const MEMBER_BEARER = "signed-in-session-token";
/** The foreign project id from the MJ-013 reproduction. */
const FOREIGN_PROJECT = "v97b52s8zxg9jdhxvdfwdv57pn8d2r8v";

function createApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = {
      getToolsForAiSdk: vi.fn().mockResolvedValue({}),
      getServerConfig: vi.fn(),
    };
    await next();
  });
  app.route("/api/mcp/chat-v2", chatV2);
  return app;
}

async function postTurn(authorization: string, projectId: string) {
  return createApp().request("/api/mcp/chat-v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: JSON.stringify({
      projectId,
      hostId: "host-emulated",
      selectedServers: ["server-1"],
      selectedServerIds: ["server-id-1"],
      messages: [{ role: "user", content: "hello" }],
      model: {
        id: "anthropic/claude-haiku-4.5",
        provider: "anthropic",
        name: "Claude Haiku 4.5",
      },
    }),
  });
}

describe("POST /api/mcp/chat-v2 — a guest's projectId is not authorization", () => {
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    fetchHostRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        hostId: "host-emulated",
        modelId: "anthropic/claude-haiku-4.5",
        systemPrompt: "host system",
        temperature: 0.2,
        requireToolApproval: false,
        respectToolVisibility: true,
        selectedServerIds: ["server-id-1"],
      },
    });
    checkHarnessRuntimeAvailableMock.mockReturnValue({ ok: true });
    listLocalRuntimeSkillsMock.mockResolvedValue([]);
    listCloudRuntimeSkillsMock.mockResolvedValue([]);
    validateGuestTokenMock.mockImplementation((token: string) =>
      token === GUEST_BEARER
        ? { valid: true, guestId: "g-1" }
        : { valid: false },
    );
    prepareChatV2Mock.mockResolvedValue({
      allTools: {},
      enhancedSystemPrompt: "system",
      resolvedTemperature: 0.2,
      scrubMessages: (messages: unknown) => messages,
      progressivePlan: undefined,
      discoveryState: undefined,
    });
    handleMCPJamFreeChatModelMock.mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
  });

  afterEach(() => {
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
  });

  it("does not carry a guest's foreign projectId into the turn", async () => {
    const response = await postTurn(`Bearer ${GUEST_BEARER}`, FOREIGN_PROJECT);

    // The turn still runs — guest chat is the feature, the project is not.
    expect(response.status).toBe(200);
    expect(handleMCPJamFreeChatModelMock).toHaveBeenCalled();

    // Nothing the turn was built from may still name the stranger's project.
    const streamArgs = handleMCPJamFreeChatModelMock.mock.calls[0]?.[0];
    expect(JSON.stringify(streamArgs ?? {})).not.toContain(FOREIGN_PROJECT);
    const prepareArgs = prepareChatV2Mock.mock.calls[0]?.[0];
    expect(JSON.stringify(prepareArgs ?? {})).not.toContain(FOREIGN_PROJECT);
  });

  it("still carries a signed-in caller's projectId", async () => {
    // The guard keys on the guest check, not on the presence of the field, so
    // this is what would break if that polarity were ever inverted.
    const response = await postTurn(`Bearer ${MEMBER_BEARER}`, "project-1");

    expect(response.status).toBe(200);
    expect(listCloudRuntimeSkillsMock).toHaveBeenCalledWith({
      authHeader: `Bearer ${MEMBER_BEARER}`,
      projectId: "project-1",
    });
  });
});
