import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const m = vi.hoisted(() => ({
  guestId: undefined as string | undefined,
  peek: vi.fn(),
  hostTools: vi.fn(),
}));
vi.mock("../local-machine-policy.js", () => ({
  resolveLocalMachinePolicy: async () => ({
    computerEngine: "cloud",
    browserEngine: "local",
    localBrowserGuestId: m.guestId,
    localBrowserRequested: true,
    localComputerRequested: false,
    requestIsGuest: Boolean(m.guestId),
    emitBrowserReadiness: () => {},
  }),
}));
vi.mock("../../browserd/page-tools-peek.js", async (original) => ({
  ...(await original<typeof import("../../browserd/page-tools-peek.js")>()),
  peekPageToolsForChatTurn: m.peek,
}));
vi.mock("../../../utils/built-in-tools/registry.js", () => ({
  resolveHostTools: m.hostTools,
}));
vi.mock("../../../utils/harness/runtime-secrets.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/harness/runtime-secrets.js")
  >()),
  fetchRuntimeSecrets: async () => ({ ok: true, secrets: [] }),
}));
vi.mock("../../../utils/computers/environment-context.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/computers/environment-context.js")
  >()),
  maybeAppendEnvironmentContext: async (args: { systemPrompt?: string }) =>
    args.systemPrompt,
}));
vi.mock("../../../routes/web/mcpjam-platform-client.js", () => ({
  buildMcpjamPlatformClient: () => undefined,
}));
import { prepareManagedTools } from "../managed-tools.js";
import { TurnResources } from "../resources.js";
import { guestBrowserProject } from "../../../utils/computers/browser-rollout.js";
import { BROWSER_BUILT_IN_TOOL_ID } from "@/shared/client-fulfilled-tools";

type Setup = Parameters<typeof prepareManagedTools>[0]["setup"];
const setup = {
  hostedBody: { projectId: "project-1", chatSessionId: "chat-1" },
  body: { chatSessionId: "chat-1" },
  turnMode: "interactive",
  pinsEnvironment: false,
  resolvedExecution: {},
  builtInToolPolicy: {},
  localBrowserSettingsUnavailable: false,
  turnBuiltInToolIds: [BROWSER_BUILT_IN_TOOL_ID],
  systemPrompt: "system",
  requireToolApproval: true,
  scenarioParticipant: false,
} as unknown as Setup;

async function prepareLocalTurn() {
  const app = new Hono<{ Variables: { guestId?: string } }>();
  app.post("/", async (c) => {
    if (m.guestId) c.set("guestId", m.guestId);
    await prepareManagedTools({
      c,
      rawBody: { browserEngine: "local" },
      bearerToken: "bearer",
      localIngress: true,
      resources: new TurnResources(() => {}),
      setup,
      connections: { validatedPageTools: [] },
    });
    return c.json({});
  });
  expect((await app.request("/", { method: "POST" })).status).toBe(200);
}

describe("managed local Browser page tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.guestId = undefined;
    m.peek.mockResolvedValue(undefined);
    m.hostTools.mockReturnValue({});
  });
  it("reads a guest's page tools from the guest-scoped session the browser tool uses", async () => {
    m.guestId = "guest-1";
    await prepareLocalTurn();
    const scoped = guestBrowserProject("project-1", "guest-1");
    expect(m.peek.mock.lastCall?.[0]).toMatchObject({
      engine: "local",
      projectId: scoped,
    });
    expect(m.hostTools.mock.lastCall?.[1]).toMatchObject({
      projectId: "project-1",
      localBrowserGuestId: "guest-1",
    });
  });
  it("reads a member's page tools from the project session", async () => {
    await prepareLocalTurn();
    expect(m.peek.mock.lastCall?.[0]).toMatchObject({
      engine: "local",
      projectId: "project-1",
    });
  });
});
