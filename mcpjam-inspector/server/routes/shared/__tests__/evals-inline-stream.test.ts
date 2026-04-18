import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamTestCaseMock = vi.hoisted(() => vi.fn());
const convexSetAuthMock = vi.hoisted(() => vi.fn());

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: convexSetAuthMock,
  })),
}));

vi.mock("../../../services/evals-runner", async () => {
  const actual =
    await vi.importActual<typeof import("../../../services/evals-runner")>(
      "../../../services/evals-runner",
    );
  return {
    ...actual,
    streamTestCase: (...args: unknown[]) => streamTestCaseMock(...args),
  };
});

import { streamInlineEvalTestCaseWithManager } from "../evals";

describe("streamInlineEvalTestCaseWithManager", () => {
  const originalConvexUrl = process.env.CONVEX_URL;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example";
  });

  afterEach(() => {
    if (originalConvexUrl === undefined) {
      delete process.env.CONVEX_URL;
    } else {
      process.env.CONVEX_URL = originalConvexUrl;
    }
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
  });

  it("aborts the inline runner when the response stream is cancelled", async () => {
    let capturedAbortSignal: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const onStreamComplete = vi.fn();
    const getToolsForAiSdk = vi.fn().mockResolvedValue({});

    streamTestCaseMock.mockImplementation(
      async (params: { abortSignal?: AbortSignal }) => {
        capturedAbortSignal = params.abortSignal;
        resolveStarted();
        await new Promise<void>((resolve) => {
          if (params.abortSignal?.aborted) {
            resolve();
            return;
          }
          params.abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return [];
      },
    );

    const stream = await streamInlineEvalTestCaseWithManager(
      {
        listServers: () => ["srv"],
        getToolsForAiSdk,
      } as any,
      {
        serverIds: ["srv"],
        model: "gpt-4",
        provider: "openai",
        test: {
          title: "Guest compare",
          query: "hello",
        },
      },
      {
        convexAuthToken: "guest-token",
        onStreamComplete,
      },
    );

    const reader = stream.getReader();
    const readPromise = reader.read();
    await started;

    await reader.cancel();
    await expect(readPromise).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(getToolsForAiSdk).toHaveBeenCalledWith(["srv"]);
    expect(capturedAbortSignal?.aborted).toBe(true);
    expect(convexSetAuthMock).toHaveBeenCalledWith("guest-token");
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
  });
});
