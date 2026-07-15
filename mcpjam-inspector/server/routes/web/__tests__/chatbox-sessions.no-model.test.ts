import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, postJson, expectJson } from "./helpers/test-app.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

const fetchChatboxRuntimeConfigMock = vi.fn();
const createRunMock = vi.fn();
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

// An unpinned host persists modelId "" (a fully supported host state), and
// the synthetic runner has no visitor picker to fall back to. The /start
// route must fail fast with an actionable 400 BEFORE the run record exists —
// pre-guard, every session died downstream on an opaque backend
// "model is required" that only reached server logs.
describe("web routes — simulate-sessions/start on a modelless host", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
    fetchChatboxRuntimeConfigMock.mockReset();
    createRunMock.mockReset();
    startSimulationMock.mockReset();
    createRunMock.mockResolvedValue({ runId: "run-1" });
    startSimulationMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
  });

  const runtimeConfigWithModel = (modelId: string) => ({
    ok: true,
    config: {
      chatboxId: "cbx-1",
      accessVersion: 0,
      modelId,
      systemPrompt: "",
      temperature: 0.7,
      requireToolApproval: false,
      hostStyle: "default",
    },
  });

  const startBody = {
    projectId: "proj-1",
    servers: [],
    personas: [{ id: "p-1", name: "Alice", role: "user", notes: "tries it" }],
    sessionsPerPersona: 1,
    maxTurns: 3,
  };

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
  ])(
    "400s with an actionable message and never creates a run (%s modelId)",
    async (_label, modelId) => {
      fetchChatboxRuntimeConfigMock.mockResolvedValue(
        runtimeConfigWithModel(modelId)
      );

      const response = await postJson(
        app,
        "/api/web/chatboxes/cbx-1/simulate-sessions/start",
        startBody,
        token
      );
      const { status, data } = await expectJson<{
        error?: { message?: string };
      }>(response);

      expect(status).toBe(400);
      expect(JSON.stringify(data)).toMatch(/no model selected/i);
      // The guard must fire before the run record exists — otherwise the
      // dialog polls a doomed "running" run.
      expect(createRunMock).not.toHaveBeenCalled();
      expect(startSimulationMock).not.toHaveBeenCalled();
    }
  );

  it("still starts the run when the host pins a model", async () => {
    fetchChatboxRuntimeConfigMock.mockResolvedValue(
      runtimeConfigWithModel("anthropic/claude-haiku-4.5")
    );

    const response = await postJson(
      app,
      "/api/web/chatboxes/cbx-1/simulate-sessions/start",
      startBody,
      token
    );
    const { status, data } = await expectJson<{ runId?: string }>(response);

    expect(status).toBe(200);
    expect(data.runId).toBe("run-1");
    expect(createRunMock).toHaveBeenCalledTimes(1);
  });
});
