/**
 * CONVEX-19R regression: the local chat route must not fetch the project skill
 * catalog for a GUEST caller.
 *
 * `listCloudRuntimeSkills` resolves `projectSkills:listSkills`, a signed-in-only
 * Convex query. This route attaches a guest bearer for anonymous callers
 * (`/api/mcp/chat-v2` is in the client's `HOSTED_AUTH_PATH_PREFIXES`), so the
 * gate used to read "has an Authorization header" as "is a member" and sent one
 * refused query per guest turn.
 *
 * The seam under test is the ROUTE's gate, so `validateGuestToken` is the only
 * thing stubbed on the guest path — the real `isGuestChatRequest` still decides,
 * which keeps a polarity change in that helper from passing here.
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

// Only `checkHarnessRuntimeAvailable` is stubbed. Spreading `actual` is
// load-bearing, not tidiness: a wholesale replacement makes every OTHER export
// the route calls `undefined(...)` at runtime — a 500 that looks like a routing
// bug rather than a missing mock entry.
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

// Spread the real modules: the route imports two of these exports, and a
// wholesale replacement would make any third one `undefined(...)` at runtime.
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

async function postTurn(authorization: string) {
  return createApp().request("/api/mcp/chat-v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: JSON.stringify({
      projectId: "project-1",
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

describe("POST /api/mcp/chat-v2 project skill catalog — guest boundary", () => {
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    // No `harness` ⇒ the emulated engine, which is the path that gathers an
    // in-memory catalog. A harness turn takes its skills on-box instead.
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

  it("fetches the catalog for a signed-in caller with a project", async () => {
    const response = await postTurn(`Bearer ${MEMBER_BEARER}`);

    expect(response.status).toBe(200);
    expect(listCloudRuntimeSkillsMock).toHaveBeenCalledWith({
      authHeader: `Bearer ${MEMBER_BEARER}`,
      projectId: "project-1",
    });
  });

  it("does NOT fetch the catalog for a guest bearer", async () => {
    // The regression. A guest bearer IS an Authorization header, so the old
    // `requestAuthHeader &&` gate let it through and the query refused it.
    const response = await postTurn(`Bearer ${GUEST_BEARER}`);

    expect(response.status).toBe(200);
    expect(listCloudRuntimeSkillsMock).not.toHaveBeenCalled();
    // The turn still runs, and still carries the local catalog.
    expect(listLocalRuntimeSkillsMock).toHaveBeenCalled();
    expect(handleMCPJamFreeChatModelMock).toHaveBeenCalled();
  });

  it("does NOT fetch the catalog on a harness turn", async () => {
    // Harness turns take their skills on-box; the two delivery channels are
    // deliberately disjoint, so this stays true for a member bearer.
    fetchHostRuntimeConfigMock.mockResolvedValueOnce({
      ok: true,
      config: {
        hostId: "host-emulated",
        modelId: "anthropic/claude-haiku-4.5",
        systemPrompt: "host system",
        temperature: 0.2,
        requireToolApproval: false,
        respectToolVisibility: true,
        selectedServerIds: ["server-id-1"],
        harness: "claude-code",
      },
    });

    await postTurn(`Bearer ${MEMBER_BEARER}`);

    expect(listCloudRuntimeSkillsMock).not.toHaveBeenCalled();
  });
});
