import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prepareEvalRunMock } = vi.hoisted(() => ({
  prepareEvalRunMock: vi.fn(),
}));

vi.mock("../../shared/evals.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/evals.js")>(
    "../../shared/evals.js",
  );
  return {
    ...actual,
    prepareEvalRun: (...args: unknown[]) => prepareEvalRunMock(...args),
  };
});

import evalsRoutes from "../evals";

function createApp(mcpClientManager: unknown) {
  const app = new Hono();
  app.use("/api/mcp/evals/*", async (c, next) => {
    (c as any).mcpClientManager = mcpClientManager;
    await next();
  });
  app.route("/api/mcp/evals", evalsRoutes);
  return app;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

const runSuiteBody = {
  projectId: "project-1",
  suiteId: "suite-1",
  suiteName: "Hosted Suite",
  tests: [
    {
      title: "Test",
      query: "Hello",
      runs: 1,
      model: "openai/gpt-5-mini",
      provider: "openai",
      expectedToolCalls: [],
    },
  ],
  serverIds: ["server-1"],
  convexAuthToken: "token-123",
};

describe("mcp eval run route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts suite runs asynchronously and responds before execution settles", async () => {
    const execution = deferred();
    const execute = vi.fn(() => execution.promise);
    prepareEvalRunMock.mockResolvedValueOnce({
      suiteId: "suite-1",
      runId: "run-1",
      caseUpsert: { committed: [], failed: [] },
      recorder: { finalize: vi.fn().mockResolvedValue(undefined) },
      execute,
    });

    const app = createApp({ id: "manager" });
    const response = await app.request("/api/mcp/evals/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(runSuiteBody),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      suiteId: "suite-1",
      runId: "run-1",
      status: "running",
      message: "Eval run started. Results will appear shortly.",
      caseUpsert: { committed: [], failed: [] },
    });
    expect(prepareEvalRunMock).toHaveBeenCalledWith(
      { id: "manager" },
      runSuiteBody,
    );

    await flushPromises();
    expect(execute).toHaveBeenCalledTimes(1);

    execution.resolve(undefined);
    await flushPromises();
  });
});
