/**
 * A stand-in for the forwarding endpoint, for runtime tests that must run
 * before `createWebConnectorEndpoint` is merged: it keeps the same seams the
 * real one does (the turn window and its approval hook, the tool-call ledger)
 * and forwards each request body to the connector's upstream unchanged.
 *
 * Not the endpoint: no OAuth, no header filtering, no streaming. The end to
 * end test runs the real one.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  hashPayload,
  type ToolCallLedger,
} from "../../../services/web-clients/tool-call-ledger";
import type { TurnWindowStore } from "../../../services/web-clients/turn-windows";

export type StandInEndpoint = { url: string; close(): Promise<void> };

export async function startStandInEndpoint(args: {
  upstreamOf: (connectorId: string) => string | undefined;
  windows: TurnWindowStore;
  ledger: ToolCallLedger;
}): Promise<StandInEndpoint> {
  const server = createServer(async (request, response) => {
    const match = /^\/mcp\/([^/?]+)/.exec(request.url ?? "");
    const connectorId = match ? decodeURIComponent(match[1]!) : undefined;
    const upstream = connectorId ? args.upstreamOf(connectorId) : undefined;
    if (!connectorId || !upstream || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = JSON.parse(raw) as {
      id?: string | number | null;
      method: string;
      params?: { name?: string; arguments?: unknown; _meta?: Record<string, unknown> };
    };
    let ledgerId: string | undefined;
    if (body.method === "tools/call") {
      const window = args.windows.active(connectorId);
      const toolUseId = body.params?._meta?.["claudecode/toolUseId"];
      const call = {
        connectorId,
        jsonrpcId: body.id ?? null,
        toolName: body.params?.name ?? "",
        arguments: body.params?.arguments,
        ...(typeof toolUseId === "string" ? { toolUseId } : {}),
      };
      const decision = window
        ? await window.approve({ ...call, turnId: window.turnId })
        : { allow: false as const, reason: "No MCPJam turn is running on this connector." };
      if (!decision.allow) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { isError: true, content: [{ type: "text", text: decision.reason }] },
          }),
        );
        return;
      }
      ledgerId = args.ledger.forwarded({
        connectorId,
        turnId: window!.turnId,
        runId: window!.runId,
        jsonrpcId: call.jsonrpcId,
        toolName: call.toolName,
        ...(call.toolUseId ? { toolUseId: call.toolUseId } : {}),
        argsHash: hashPayload(call.arguments ?? {}),
      }).id;
    }
    const forwarded = await fetch(upstream, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: request.headers.accept ?? "application/json",
      },
      body: raw,
    });
    const text = await forwarded.text();
    if (ledgerId) {
      args.ledger.settle(ledgerId, {
        state: forwarded.ok ? "result" : "error",
        upstreamStatus: forwarded.status,
        ...(text ? { resultHash: hashPayload(text) } : {}),
      });
    }
    response.writeHead(forwarded.status, {
      "content-type": forwarded.headers.get("content-type") ?? "application/json",
    });
    response.end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
