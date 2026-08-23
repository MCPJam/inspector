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

    runEphemeralConnectionMock.mockImplementation(
      async (_c, _rawBody, _schema, coreFn) =>
        coreFn({ executeTool }, { serverId: "s1", toolName: "echo", parameters: {} })
    );

    const res = await makeApp().request(
      "/api/v1/projects/p1/servers/s1/tools/call",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok",
        },
        body: JSON.stringify({ toolName: "echo" }),
      }
    );

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
});
