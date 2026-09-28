/** Tiny stateless MCP endpoint for the native delivery smoke test. */
import { createServer } from "node:http";

export async function startDeliveryMcp() {
  let calls = 0;
  let connections = 0;
  const server = createServer(async (request, response) => {
    if (request.url !== "/mcp?k=delivery-capability-canary") {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    switch (message.method) {
      case "initialize":
        result = { protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} }, serverInfo: { name: "delivery-probe", version: "1" } };
        break;
      case "tools/list":
        result = { tools: [{ name: "ping", description: "Delivery conformance probe",
          inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] };
        break;
      case "tools/call":
        calls++;
        result = { content: [{ type: "text", text: "DELIVERY_MCP_OK" }] };
        break;
      default:
        result = {};
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.on("connection", () => { connections++; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No MCP test listener");
  return {
    url: `http://127.0.0.1:${address.port}/mcp?k=delivery-capability-canary`,
    calls: () => calls,
    connections: () => connections,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
