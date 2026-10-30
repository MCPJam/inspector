import { expect, it } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import { forwardingAdmission } from "../enhanced-admission";
const caps = {
  extensions: {
    "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
  },
};
function candidate(config: Record<string, unknown> = {}, capabilities = caps) {
  return {
    manager: {
      getServerConfig: () => ({
        url: "https://fixture.test/mcp",
        timeout: 60_000,
        capabilities,
        ...config,
      }),
      getInitializationInfo: () => ({
        protocolVersion: "2026-07-28",
        transport: "streamable-http",
        clientCapabilities: capabilities,
      }),
    } as unknown as MCPClientManager,
    serverIds: ["server"],
  };
}
it("selects the qualified modern bridge before starting the CLI", () => {
  expect(forwardingAdmission(candidate()).delivery).toBe("bridge");
});
it("retains the existing path for connection behavior the bridge cannot reproduce", () => {
  expect(
    forwardingAdmission(
      candidate({ requestInit: { headers: { authorization: "private" } } }),
    ).delivery,
  ).toBeUndefined();
  expect(
    forwardingAdmission(candidate({ sessionId: "legacy" })).delivery,
  ).toBeUndefined();
  expect(
    forwardingAdmission({ ...candidate(), hasTasks: true }).delivery,
  ).toBeUndefined();
  expect(
    forwardingAdmission({
      ...candidate(),
      modelVisibleMcpToolResults: { directContent: { text: false } },
    }).delivery,
  ).toBeUndefined();
});
