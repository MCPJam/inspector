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

describe("web routes — chatbox-sessions BYOK gate removed", () => {
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

  const validBody = {
    projectId: "proj-1",
    servers: [{ serverId: "srv-1", serverName: "srv-1" }],
    personas: [
      { id: "p-1", name: "Alice", role: "user", notes: "tries the feature" },
    ],
    sessionsPerPersona: 1,
    maxTurns: 3,
  };

  it("no longer returns 400 byok_unsupported for a chatbox whose modelId is not MCPJam-provided", async () => {
    fetchChatboxRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        chatboxId: "cbx-1",
        accessVersion: 0,
        // Bare gpt-4o (no openai/ prefix) is BYOK, not MCPJam-provided.
        modelId: "gpt-4o",
        systemPrompt: "",
        temperature: 0.7,
        requireToolApproval: false,
        hostStyle: "default",
      },
    });

    const response = await postJson(
      app,
      "/api/web/chatboxes/cbx-1/simulate-sessions/start",
      validBody,
      token,
    );
    const { status, data } = await expectJson<{
      runId?: string;
      code?: string;
      errorCode?: string;
    }>(response);

    expect(status).toBe(200);
    expect(data.runId).toBe("run-1");
    expect(createRunMock).toHaveBeenCalledTimes(1);
    // Specifically: the old byok_unsupported error must not appear.
    expect(data.errorCode).toBeUndefined();
  });

  it("still accepts MCPJam-provided modelIds (regression)", async () => {
    fetchChatboxRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        chatboxId: "cbx-2",
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
      "/api/web/chatboxes/cbx-2/simulate-sessions/start",
      validBody,
      token,
    );
    const { status, data } = await expectJson<{ runId?: string }>(response);

    expect(status).toBe(200);
    expect(data.runId).toBe("run-1");
  });

  it("threads computer-backed built-ins into swarm simulation", async () => {
    fetchChatboxRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        chatboxId: "cbx-computer",
        accessVersion: 0,
        modelId: "openai/gpt-4o-mini",
        systemPrompt: "",
        temperature: 0.7,
        requireToolApproval: true,
        hostStyle: "default",
        builtInToolIds: ["bash"],
        computer: { kind: "personal", workdir: "/workspace" },
      },
    });

    const response = await postJson(
      app,
      "/api/web/chatboxes/cbx-computer/simulate-sessions/start",
      validBody,
      token,
    );
    const { status, data } = await expectJson<{ runId?: string }>(response);

    expect(status).toBe(200);
    expect(data.runId).toBe("run-1");
    await new Promise((resolve) => setImmediate(resolve));
    expect(startSimulationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        builtInToolIds: ["bash"],
        computer: { kind: "personal", workdir: "/workspace" },
        requireToolApproval: true,
      })
    );
  });
});
