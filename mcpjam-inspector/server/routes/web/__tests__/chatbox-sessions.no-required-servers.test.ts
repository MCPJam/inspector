import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, postJson, expectJson } from "./helpers/test-app.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

const fetchChatboxRuntimeConfigMock = vi.fn();
const createRunMock = vi.fn();
const generatePersonasMock = vi.fn();
const startSimulationMock = vi.fn();

vi.mock("../../../utils/chatbox-runtime-config.js", () => ({
  fetchChatboxRuntimeConfig: (...args: unknown[]) =>
    fetchChatboxRuntimeConfigMock(...args),
}));

vi.mock("../../../services/session-agent.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/session-agent.js")
  >("../../../services/session-agent.js");
  return {
    ...actual,
    createRun: (...args: unknown[]) => createRunMock(...args),
    generatePersonas: (...args: unknown[]) => generatePersonasMock(...args),
  };
});

vi.mock("../../../services/sessionSimulation/runner.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/sessionSimulation/runner.js")
  >("../../../services/sessionSimulation/runner.js");
  return {
    ...actual,
    startSimulation: (...args: unknown[]) => startSimulationMock(...args),
  };
});

// A chatbox whose attachments are all optional (or absent) used to 400 with
// "Chatbox has no required servers". Persona generation now degrades to
// surface-name grounding and the simulation runs toolless instead.
describe("web routes — chatbox-sessions with no required servers", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
    fetchChatboxRuntimeConfigMock.mockReset();
    createRunMock.mockReset();
    generatePersonasMock.mockReset();
    startSimulationMock.mockReset();
    createRunMock.mockResolvedValue({ runId: "run-1" });
    startSimulationMock.mockResolvedValue(undefined);
    generatePersonasMock.mockResolvedValue([
      { id: "p-1", name: "Curious First-Time User", role: "user", notes: "" },
    ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
  });

  const allOptionalServers = [
    { serverId: "srv-1", serverName: "srv-1", optional: true },
  ];

  it("generate-personas accepts an all-optional server list", async () => {
    const response = await postJson(
      app,
      "/api/web/chatboxes/cbx-1/generate-personas",
      {
        projectId: "proj-1",
        servers: allOptionalServers,
        personaCount: 3,
        chatboxName: "Drawing Assistant",
      },
      token,
    );
    const { status, data } = await expectJson<{
      personas?: Array<{ id: string }>;
    }>(response);

    expect(status).toBe(200);
    expect(data.personas).toHaveLength(1);
    expect(generatePersonasMock).toHaveBeenCalledTimes(1);
    // The captured snapshot has zero servers; the attachment still carries
    // the chatbox name for surface grounding with an empty scope.
    const [toolSnapshot, , , , , , serverAttachment] =
      generatePersonasMock.mock.calls[0];
    expect(toolSnapshot.servers).toEqual([]);
    expect(serverAttachment).toMatchObject({
      name: "Drawing Assistant",
      resolvedServerNames: [],
    });
  });

  it("generate-personas accepts an empty server list", async () => {
    const response = await postJson(
      app,
      "/api/web/chatboxes/cbx-1/generate-personas",
      { projectId: "proj-1", servers: [], personaCount: 2 },
      token,
    );
    const { status } = await expectJson(response);
    expect(status).toBe(200);
    expect(generatePersonasMock).toHaveBeenCalledTimes(1);
  });

  it("simulate-sessions/start accepts an all-optional server list", async () => {
    fetchChatboxRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        chatboxId: "cbx-1",
        accessVersion: 0,
        modelId: "openai/gpt-4o-mini",
        systemPrompt: "",
        temperature: 0.7,
        requireToolApproval: false,
        hostStyle: "default",
      },
    });

    const response = await postJson(
      app,
      "/api/web/chatboxes/cbx-1/simulate-sessions/start",
      {
        projectId: "proj-1",
        servers: allOptionalServers,
        personas: [
          { id: "p-1", name: "Alice", role: "user", notes: "tries it" },
        ],
        sessionsPerPersona: 1,
        maxTurns: 3,
      },
      token,
    );
    const { status, data } = await expectJson<{ runId?: string }>(response);

    expect(status).toBe(200);
    expect(data.runId).toBe("run-1");
    expect(createRunMock).toHaveBeenCalledTimes(1);
  });
});
