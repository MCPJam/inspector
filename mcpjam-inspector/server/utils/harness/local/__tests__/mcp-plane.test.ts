import { afterEach, describe, expect, it, vi } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import { startLocalHarnessMcpPlane } from "../mcp-plane.js";
let plane: Awaited<ReturnType<typeof startLocalHarnessMcpPlane>> | undefined;
afterEach(async () => { await plane?.close(); plane = undefined; });
async function fixture(options: Partial<Parameters<typeof startLocalHarnessMcpPlane>[0]> = {}) {
  const listTools = vi.fn(async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }));
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "hello" }] }));
  const manager = { hasServer: (id: string) => ["selected", "private"].includes(id), listTools, executeTool: callTool } as unknown as MCPClientManager;
  plane = await startLocalHarnessMcpPlane({ manager, serverIds: ["selected"], turnId: "turn", ...options });
  const request = (serverId: string, token = plane!.strategy.token, origin?: string) => fetch(`${plane!.strategy.baseUrl}/${serverId}`, { method: "POST", headers: { "content-type": "application/json", "x-mcpjam-proxy-token": token, ...(origin ? { origin } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  return { request, listTools, callTool };
}
describe("local MCP plane", () => {
  it("refuses absent/wrong capabilities and browser origins before touching a server", async () => {
    const { request, listTools } = await fixture();
    expect((await request("selected", "wrong")).status).toBe(403);
    expect((await request("selected", undefined, "https://attacker.example")).status).toBe(403);
    expect(listTools).not.toHaveBeenCalled();
  });
  it("exposes only this turn's selected servers and closes after the turn", async () => {
    const { request, listTools } = await fixture();
    expect((await request("private")).status).toBe(404);
    const response = await request("selected");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { tools: [{ name: "echo" }] } });
    expect(listTools).toHaveBeenCalledOnce();
    await plane!.close();
    await expect(request("selected")).rejects.toThrow();
  });
});

async function call() {
  return fetch(`${plane!.strategy.baseUrl}/selected`, {
    method: "POST", headers: { "content-type": "application/json", "x-mcpjam-proxy-token": plane!.strategy.token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { value: "hello" } } }),
  });
}
it("blocks denied tools before execution or evidence capture", async () => {
  const evidence = vi.fn();
  const { callTool } = await fixture({ evidence, toolPolicy: { selected: { mode: "default", known: ["echo"], denied: { echo: { reason: "denyList", classification: "unknown" } }, unknownTool: "deny" } } });
  const result = await (await call()).json();
  expect(result.result._meta["mcpjam/policyBlock"].reason).toBe("denyList");
  expect(callTool).not.toHaveBeenCalled();
  expect(evidence).not.toHaveBeenCalled();
});
it("fails closed before a tool side effect when evidence cannot start", async () => {
  const afterExecute = vi.fn();
  const { callTool } = await fixture({ evidence: () => ({ beforeExecute: async () => ({ ok: false, reason: "Evidence unavailable" }), afterExecute }) });
  expect(JSON.stringify(await (await call()).json())).toContain("Evidence unavailable");
  expect(callTool).not.toHaveBeenCalled();
  expect(afterExecute).not.toHaveBeenCalled();
});
it("settles the exact tool outcome before returning it", async () => {
  const order: string[] = [];
  const afterExecute = vi.fn(async () => { order.push("settled"); });
  const { callTool } = await fixture({ evidence: () => ({ beforeExecute: async () => { order.push("started"); return { ok: true }; }, afterExecute }) });
  callTool.mockImplementation(async () => { order.push("executed"); return { content: [{ type: "text", text: "hello" }] }; });
  const result = await (await call()).json();
  expect(order).toEqual(["started", "executed", "settled"]);
  expect(afterExecute).toHaveBeenCalledWith(expect.objectContaining({ serverId: "selected", toolName: "echo", outcome: { kind: "result", result: result.result } }));
});
