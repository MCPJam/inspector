import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const streamInlineEvalTestCaseWithManagerMock = vi.hoisted(() => vi.fn());

vi.mock("../../shared/evals.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/evals.js")>(
    "../../shared/evals.js",
  );
  return {
    ...actual,
    streamInlineEvalTestCaseWithManager: (...args: unknown[]) =>
      streamInlineEvalTestCaseWithManagerMock(...args),
  };
});

import evalsRoutes from "../evals";

function createApp() {
  const app = new Hono();
  app.route("/api/mcp/evals", evalsRoutes);
  return app;
}

describe("mcp eval inline stream route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const encoder = new TextEncoder();
    streamInlineEvalTestCaseWithManagerMock.mockResolvedValue(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"complete","iterationId":"guestiter-1","iteration":{"_id":"guestiter-1"}}\n\n',
            ),
          );
          controller.close();
        },
      }),
    );
  });

  it("streams guest inline compare runs from /api/mcp/evals/stream-test-case-inline", async () => {
    const response = await createApp().request(
      "/api/mcp/evals/stream-test-case-inline",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          serverIds: ["srv"],
          model: "gpt-4",
          provider: "openai",
          compareRunId: "cmp_guest",
          convexAuthToken: "guest-token",
          test: {
            title: "Guest compare",
            query: "hello",
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await expect(response.text()).resolves.toContain('"type":"complete"');
    expect(streamInlineEvalTestCaseWithManagerMock).toHaveBeenCalledTimes(1);
    expect(
      streamInlineEvalTestCaseWithManagerMock.mock.calls[0]?.[1],
    ).toEqual(
      expect.objectContaining({
        serverIds: ["srv"],
        model: "gpt-4",
        provider: "openai",
        compareRunId: "cmp_guest",
      }),
    );
    expect(
      streamInlineEvalTestCaseWithManagerMock.mock.calls[0]?.[2],
    ).toEqual({
      convexAuthToken: "guest-token",
    });
  });
});
