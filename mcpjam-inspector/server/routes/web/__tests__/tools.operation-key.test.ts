import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import type { ZodType } from "zod";

/**
 * The hosted tools/execute route sends an operation key as the call's `_meta`
 * on every wire, so a retried write to a mock's records applies once. The MRTR
 * wrapper is stubbed to parse the body and run the verb, as in
 * tools.task-registry.test.ts.
 */
const executeTool = vi.fn();

vi.mock("../mrtr-direct.js", () => ({
  runHostedDirectMrtrOperation: async (
    c: Context,
    schema: ZodType,
    _meta: unknown,
    runVerb: (manager: unknown, body: unknown, forwardLogMessages: (serverId: string) => void) => Promise<unknown>,
  ) => {
    const parsed = schema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: { code: "VALIDATION_ERROR" } }, 400);
    const result = await runVerb({ executeTool }, parsed.data, () => undefined);
    return c.json(result as Record<string, unknown>, 200);
  },
}));
vi.mock("../../../utils/analytics.js", () => ({ captureServerEvent: vi.fn() }));

const toolsRoute = (await import("../tools.js")).default;

const KEY_META = { "mcpjam.com/operationKey": "retry-1" };

function post(body: Record<string, unknown>) {
  return toolsRoute.request("/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: "p1", serverId: "s1", toolName: "close_ticket", parameters: { id: "123" }, ...body }),
  });
}

describe("hosted tools/execute and an operation key", () => {
  beforeEach(() => {
    executeTool.mockReset();
    executeTool.mockResolvedValue({ content: [] });
  });

  it("sends the key on an ordinary call, and none without one", async () => {
    expect((await post({ operationKey: "retry-1" })).status).toBe(200);
    expect((await post({})).status).toBe(200);
    expect(executeTool.mock.calls.map((call) => call[3]?.metadata)).toEqual([KEY_META, undefined]);
  });

  it("sends the key on both task wires and keeps each wire's opt-in", async () => {
    await post({ operationKey: "retry-1", allowTaskResult: true });
    await post({ operationKey: "retry-1", taskOptions: { ttl: 60_000 } });
    expect(executeTool.mock.calls.map((call) => call[3])).toEqual([
      { allowTaskResult: true, metadata: KEY_META },
      { metadata: KEY_META, task: { ttl: 60_000 } },
    ]);
  });
});
