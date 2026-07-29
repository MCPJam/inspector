/**
 * Finding 5 (MCP Tasks): the single-case eval stream must stop its work when
 * the client goes away. `streamEvalTestCaseWithManager` wires ONE
 * AbortController into both consumers — `streamTestCase`'s `abortSignal`
 * (previously unwired here) and the task seam's `await.signal` — and aborts
 * it from BOTH teardown paths: the HTTP request's abort signal and the
 * returned ReadableStream's `cancel()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTasksPolicy } from "@mcpjam/sdk";

const queryMock = vi.hoisted(() => vi.fn());
const streamTestCaseMock = vi.hoisted(() => vi.fn());

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class MockConvexHttpClient {
    setAuth = vi.fn();
    query = (...args: unknown[]) => queryMock(...args);
    mutation = vi.fn(async () => null);
    action = vi.fn(async () => null);
  },
}));

vi.mock("../../../services/evals-runner", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/evals-runner")
  >("../../../services/evals-runner");
  return {
    ...actual,
    streamTestCase: (...args: unknown[]) => streamTestCaseMock(...args),
  };
});

import { streamEvalTestCaseWithManager } from "../evals";

type CapturedToolsOptions =
  | { tasks?: { mode?: string; await?: { signal?: AbortSignal } } }
  | undefined;

describe("streamEvalTestCaseWithManager abort wiring", () => {
  let capturedToolsOptions: CapturedToolsOptions;
  const clientManager = {
    listServers: vi.fn(() => ["srv-1"]),
    getToolsForAiSdk: vi.fn(
      async (_serverIds: string[], options?: CapturedToolsOptions) => {
        capturedToolsOptions = options;
        return {};
      }
    ),
  };

  // A host config whose tasks policy is ON, so the eval surface resolves an
  // `await`-mode seam and the test can see the signal threaded into it.
  const tasksOnHostConfig = setTasksPolicy(
    { hostStyle: "claude" } as Record<string, unknown>,
    true
  );

  beforeEach(() => {
    vi.clearAllMocks();
    capturedToolsOptions = undefined;
    process.env.CONVEX_URL = "https://example.convex.cloud";
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    queryMock.mockImplementation(async (name: string) => {
      if (name === "testSuites:getTestCase") {
        return {
          _id: "case-1",
          title: "Case",
          query: "Hello",
          evalTestSuiteId: "suite-1",
        };
      }
      if (name === "hostConfigsV2:getSuiteConfig") return tasksOnHostConfig;
      if (name === "testSuites:listTestIterations") return [];
      return null;
    });
    // A run that never finishes on its own: it ends ONLY when the abort
    // signal it received fires — mirroring an in-flight awaited task.
    streamTestCaseMock.mockImplementation(
      (params: { abortSignal?: AbortSignal }) =>
        new Promise((resolve) => {
          if (!params.abortSignal || params.abortSignal.aborted) {
            resolve([]);
            return;
          }
          params.abortSignal.addEventListener("abort", () => resolve([]), {
            once: true,
          });
        })
    );
  });

  afterEach(() => {
    delete process.env.CONVEX_URL;
    delete process.env.CONVEX_HTTP_URL;
  });

  const request = {
    testCaseId: "case-1",
    model: "gpt-4",
    provider: "openai",
    serverIds: ["srv-1"],
    convexAuthToken: "token",
    modelApiKeys: { openai: "sk-test" },
  } as Parameters<typeof streamEvalTestCaseWithManager>[1];

  async function drain(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    for (let i = 0; i < 32; i++) {
      const { done } = await reader.read();
      if (done) return;
    }
    throw new Error("stream did not finish");
  }

  it("aborting the HTTP request aborts streamTestCase AND the task seam signal", async () => {
    const requestController = new AbortController();
    const stream = await streamEvalTestCaseWithManager(
      clientManager as never,
      request,
      { requestSignal: requestController.signal }
    );

    await vi.waitFor(() => expect(streamTestCaseMock).toHaveBeenCalledOnce());
    const params = streamTestCaseMock.mock.calls[0][0] as {
      abortSignal?: AbortSignal;
    };
    expect(params.abortSignal).toBeInstanceOf(AbortSignal);
    expect(params.abortSignal?.aborted).toBe(false);

    // ONE controller: the seam's await signal is the same signal the
    // iteration loop got, so a disconnect stops both.
    expect(capturedToolsOptions?.tasks?.mode).toBe("await");
    expect(capturedToolsOptions?.tasks?.await?.signal).toBe(params.abortSignal);

    requestController.abort();
    expect(params.abortSignal?.aborted).toBe(true);

    await drain(stream);
  });

  it("cancelling the returned stream aborts the run", async () => {
    const stream = await streamEvalTestCaseWithManager(
      clientManager as never,
      request
    );

    await vi.waitFor(() => expect(streamTestCaseMock).toHaveBeenCalledOnce());
    const params = streamTestCaseMock.mock.calls[0][0] as {
      abortSignal?: AbortSignal;
    };
    expect(params.abortSignal?.aborted).toBe(false);

    await stream.cancel();
    expect(params.abortSignal?.aborted).toBe(true);
  });

  it("a request already aborted at call time starts the run pre-aborted", async () => {
    const requestController = new AbortController();
    requestController.abort();

    const stream = await streamEvalTestCaseWithManager(
      clientManager as never,
      request,
      { requestSignal: requestController.signal }
    );

    await vi.waitFor(() => expect(streamTestCaseMock).toHaveBeenCalledOnce());
    const params = streamTestCaseMock.mock.calls[0][0] as {
      abortSignal?: AbortSignal;
    };
    expect(params.abortSignal?.aborted).toBe(true);
    await drain(stream);
  });
});
