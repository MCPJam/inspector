import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  streamInlineEvalTestCaseWithManagerMock,
  disconnectAllServersMock,
} = vi.hoisted(() => ({
  streamInlineEvalTestCaseWithManagerMock: vi.fn(),
  disconnectAllServersMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    MCPClientManager: vi.fn().mockImplementation(() => ({
      disconnectAllServers: disconnectAllServersMock,
    })),
  };
});

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

import { createWebTestApp, postJson } from "./helpers/test-app.js";
import {
  initGuestTokenSecret,
  issueGuestToken,
} from "../../../services/guest-token.js";

describe("web eval guest inline stream route", () => {
  const originalGuestJwtKeyDir = process.env.GUEST_JWT_KEY_DIR;
  const originalLocalSigning = process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING;
  let testGuestKeyDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testGuestKeyDir = mkdtempSync(
      path.join(os.tmpdir(), "evals-inline-guest-"),
    );
    process.env.GUEST_JWT_KEY_DIR = testGuestKeyDir;
    process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING = "true";
    initGuestTokenSecret();

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

  afterEach(() => {
    rmSync(testGuestKeyDir, { recursive: true, force: true });
    if (originalGuestJwtKeyDir === undefined) {
      delete process.env.GUEST_JWT_KEY_DIR;
    } else {
      process.env.GUEST_JWT_KEY_DIR = originalGuestJwtKeyDir;
    }
    if (originalLocalSigning === undefined) {
      delete process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING;
    } else {
      process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING = originalLocalSigning;
    }
  });

  it("streams hosted guest inline compare runs from /api/web/evals/stream-test-case-inline", async () => {
    const { app } = createWebTestApp();
    const { token } = issueGuestToken();

    const response = await postJson(
      app,
      "/api/web/evals/stream-test-case-inline",
      {
        serverIds: ["__guest__"],
        serverUrl: "https://guest.example.com/mcp",
        model: "gpt-4",
        provider: "openai",
        compareRunId: "cmp_guest",
        test: {
          title: "Guest compare",
          query: "hello",
        },
      },
      token,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await expect(response.text()).resolves.toContain('"type":"complete"');
    expect(streamInlineEvalTestCaseWithManagerMock).toHaveBeenCalledTimes(1);
    expect(
      streamInlineEvalTestCaseWithManagerMock.mock.calls[0]?.[1],
    ).toEqual(
      expect.objectContaining({
        workspaceId: "__guest__",
        serverIds: ["__guest__"],
        model: "gpt-4",
        provider: "openai",
        compareRunId: "cmp_guest",
      }),
    );
    expect(
      streamInlineEvalTestCaseWithManagerMock.mock.calls[0]?.[2],
    ).toEqual(
      expect.objectContaining({
        convexAuthToken: token,
      }),
    );
  });
});
