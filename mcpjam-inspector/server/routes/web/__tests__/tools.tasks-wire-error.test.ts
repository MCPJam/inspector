import { describe, expect, it, vi } from "vitest";

/**
 * The hosted tools/execute route must map the SDK's typed tasks wire-mismatch
 * error onto the same taxonomy as /api/web/tasks/* (400 TASKS_UNSUPPORTED) —
 * never a 500: the hosted client treats non-TASKS_UNSUPPORTED failures as
 * transient and would retry a wire mismatch forever. The MRTR wrapper is
 * stubbed with a miniature that invokes the verb and surfaces a thrown
 * `WebRouteError` the way the real error middleware does.
 */

let managerImpl: Record<string, unknown> = {};

vi.mock("../mrtr-direct.js", () => ({
  runHostedDirectMrtrOperation: async (
    c: any,
    schema: any,
    _meta: unknown,
    runVerb: (
      manager: any,
      body: any,
      forwardLogMessages: (serverId: string) => void,
    ) => Promise<unknown>,
  ) => {
    const { WebRouteError } = await import("../errors.js");
    const parsed = schema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: { code: "VALIDATION_ERROR" } }, 400);
    }
    try {
      const result = await runVerb(managerImpl, parsed.data, () => {});
      return c.json(result as Record<string, unknown>, 200);
    } catch (error) {
      if (error instanceof WebRouteError) {
        return c.json(
          {
            error: {
              code: error.code,
              message: error.message,
              ...(error.details ?? {}),
            },
          },
          error.status,
        );
      }
      return c.json({ error: { code: "INTERNAL_ERROR" } }, 500);
    }
  },
}));

vi.mock("../../../utils/analytics.js", () => ({
  captureServerEvent: vi.fn(),
}));

const toolsRoute = (await import("../tools.js")).default;
const { MCPTasksWireError } = await import("@mcpjam/sdk");

function post(body: Record<string, unknown>) {
  return toolsRoute.request("/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: "p1",
      serverId: "s1",
      toolName: "slow_tool",
      parameters: {},
      ...body,
    }),
  });
}

describe("hosted tools/execute tasks wire-mismatch mapping", () => {
  it("maps MCPTasksWireError to 400 TASKS_UNSUPPORTED, not 500", async () => {
    managerImpl = {
      executeTool: vi
        .fn()
        .mockRejectedValue(
          new MCPTasksWireError("wrong wire for task-augmented call", "extension"),
        ),
      getTasksSupport: vi.fn().mockReturnValue({ wire: "extension" }),
    };

    const res = await post({ taskOptions: { ttl: 1000 } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; wire?: string };
    };
    expect(body.error.code).toBe("TASKS_UNSUPPORTED");
    expect(body.error.wire).toBe("extension");
  });

  it("leaves unrelated execution failures on the 500 path", async () => {
    managerImpl = {
      executeTool: vi.fn().mockRejectedValue(new Error("server exploded")),
      getTasksSupport: vi.fn().mockReturnValue({ wire: "extension" }),
    };

    const res = await post({});
    expect(res.status).toBe(500);
  });
});
