import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { runEphemeralConnectionMock, validateGuestTokenMock } = vi.hoisted(
  () => ({
    runEphemeralConnectionMock: vi.fn(),
    validateGuestTokenMock: vi.fn(),
  })
);

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../web/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../web/auth.js")>(
    "../../web/auth.js"
  );
  return { ...actual, runEphemeralConnection: runEphemeralConnectionMock };
});

import v1Routes from "../index.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function stubConnection(
  executeTool: ReturnType<typeof vi.fn>,
  body: Record<string, unknown> = {
    serverId: "s1",
    toolName: "echo",
    parameters: {},
  }
) {
  runEphemeralConnectionMock.mockImplementation(
    async (_c, _rawBody, _schema, coreFn) => coreFn({ executeTool }, body)
  );
}

async function postToolsCall(): Promise<Response> {
  return makeApp().request("/api/v1/projects/p1/servers/s1/tools/call", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
    },
    body: JSON.stringify({ toolName: "echo" }),
  });
}

describe("POST /v1/projects/:projectId/servers/:serverId/tools/call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });

  it("returns the MCP CallToolResult plus additive durationMs", async () => {
    const executeTool = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        content: [{ type: "text", text: "ok" }],
      };
    });
    stubConnection(executeTool);

    const res = await postToolsCall();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content?: unknown[];
      durationMs?: number;
    };
    expect(body.content).toEqual([{ type: "text", text: "ok" }]);
    expect(typeof body.durationMs).toBe("number");
    expect(body.durationMs).toBeGreaterThanOrEqual(5);
    expect(executeTool).toHaveBeenCalledWith("s1", "echo", {});
  });

  it("clamps durationMs to zero when the clock moves backward", async () => {
    const executeTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    stubConnection(executeTool);
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(900);

    try {
      const res = await postToolsCall();

      expect(res.status).toBe(200);
      const body = (await res.json()) as { durationMs?: number };
      expect(body.durationMs).toBe(0);
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    ["null", null],
    ["primitive", "ok"],
    ["array", [{ name: "echo" }]],
  ] as const)("preserves a %s result without durationMs", async (_label, result) => {
    stubConnection(vi.fn().mockResolvedValue(result));

    const res = await postToolsCall();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
  });

  it("never overwrites a durationMs the server reported itself", async () => {
    stubConnection(
      vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        durationMs: 7,
      })
    );

    const res = await postToolsCall();

    expect(res.status).toBe(200);
    // `CallToolResult` allows extra keys. Reporting our own number by
    // destroying the server's is worse than not reporting one.
    expect(await res.json()).toEqual({
      content: [{ type: "text", text: "ok" }],
      durationMs: 7,
    });
  });

  it.each([
    ["taskOptions", { taskOptions: { ttl: 1_000 } }],
    ["allowTaskResult", { allowTaskResult: true }],
  ])("rejects %s with FEATURE_NOT_SUPPORTED", async (_label, extra) => {
    const executeTool = vi.fn();
    stubConnection(executeTool, {
      serverId: "s1",
      toolName: "echo",
      parameters: {},
      ...extra,
    });

    const res = await postToolsCall();
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("FEATURE_NOT_SUPPORTED");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("maps executeTool failures through the v1 error envelope", async () => {
    stubConnection(vi.fn().mockRejectedValue(new Error("tool exploded")));

    const res = await postToolsCall();
    const body = (await res.json()) as { code?: string; message?: string };

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(typeof body.code).toBe("string");
    expect(body.code).not.toBeUndefined();
    expect(body).not.toHaveProperty("durationMs");
  });
});
