/** Session-scoped loopback MCP transport over the caller's authorized manager. */
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import { handleJsonRpc, parseAndValidateJsonRpc, type ToolCallEvidenceHook } from "../../../services/mcp-http-bridge.js";
import { evaluateHarnessProxyToolPolicy } from "../harness-proxy-policy-enforcement.js";
import { publishHarnessPolicyBlock } from "../harness-policy-block-channel.js";
import { publishHarnessScopeStepUp } from "../harness-scope-step-up.js";
import { scopeStepUpInfoFromToolError } from "../../insufficient-scope-step-up.js";

export async function startLocalHarnessMcpPlane(args: {
  manager: MCPClientManager;
  serverIds: string[];
  turnId: string;
  toolPolicy?: Record<string, ToolPolicySnapshot>;
  evidence?: () => ToolCallEvidenceHook;
}) {
  const token = randomBytes(32).toString("base64url");
  const allowed = new Set(args.serverIds);
  let closed = false;
  const server = createServer(async (request, response) => {
    const finish = (status: number, body?: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      const presented = request.headers["x-mcpjam-proxy-token"];
      if (closed || typeof presented !== "string" || Buffer.byteLength(presented) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(presented), Buffer.from(token))) {
        finish(403); return;
      }
      // Browser pages never get cross-origin access, even if a capability leaks.
      if (request.headers.origin) { finish(403); return; }
      const serverId = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1));
      if (!allowed.has(serverId)) { finish(404); return; }
      if (request.method !== "POST") { finish(405); return; }
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) { finish(413); return; }
        chunks.push(Buffer.from(chunk));
      }
      const parsed = await parseAndValidateJsonRpc(async () => JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!parsed.ok) { finish(parsed.status, parsed.response); return; }
      const policy = args.toolPolicy?.[serverId];
      if (policy) {
        const block = evaluateHarnessProxyToolPolicy({ body: parsed.body, policyServerId: serverId, policy, hasServer: id => args.manager.hasServer(id) });
        if (block) {
          publishHarnessPolicyBlock(args.turnId, { serverId, ...block.marker, at: Date.now() });
          finish(200, block.response); return;
        }
      }
      // The bridge accepts prefixed tool names; limit its resolver to this entry
      // so a server's capability cannot route to another configured server.
      const manager = new Proxy(args.manager, {
        get(target, key) {
          if (key === "hasServer") return (id: string) => id === serverId && target.hasServer(id);
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const result = await handleJsonRpc(serverId, parsed.body, manager, "adapter", {
        ...(args.evidence ? { toolCallEvidence: args.evidence() } : {}),
        onToolCallError: async context => {
          const info = scopeStepUpInfoFromToolError(context);
          if (info) publishHarnessScopeStepUp(args.turnId, info);
        },
      });
      finish(result === null ? 202 : 200, result ?? undefined);
    } catch {
      finish(500, { error: "Local MCP request failed" });
    }
  });
  server.requestTimeout = 120_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback MCP listener");
  return {
    strategy: { plane: "local-loopback" as const, baseUrl: `http://127.0.0.1:${address.port}`, token },
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
