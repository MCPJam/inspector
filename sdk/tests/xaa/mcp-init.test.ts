import { describe, expect, it } from "vitest";
import {
  buildMcpInitializeRequest,
  evaluateMcpInitializeResponse,
  mcpInitializeExtensionEvidence,
  MCP_INIT_ID,
  MCP_PROTOCOL_VERSION,
  XAA_MCP_EXTENSION,
} from "../../src/xaa/mcp-init.js";

const ok = { jsonrpc: "2.0", id: MCP_INIT_ID, result: { capabilities: {} } };

describe("buildMcpInitializeRequest", () => {
  it("sends the bearer + protocol header and advertises the XAA extension", () => {
    const req = buildMcpInitializeRequest("at-123");
    expect(req.headers.Authorization).toBe("Bearer at-123");
    expect(req.headers["MCP-Protocol-Version"]).toBe(MCP_PROTOCOL_VERSION);
    expect(req.body.id).toBe(MCP_INIT_ID);
    expect(req.body.method).toBe("initialize");
    const params = req.body.params as Record<string, any>;
    expect(params.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(params.capabilities.extensions).toHaveProperty(XAA_MCP_EXTENSION);
  });
});

describe("evaluateMcpInitializeResponse", () => {
  it("accepts a genuine initialize result", () => {
    expect(evaluateMcpInitializeResponse(ok)).toBeUndefined();
  });

  it("unwraps the SSE envelope", () => {
    expect(
      evaluateMcpInitializeResponse({ transport: "sse", mcpResponse: ok }),
    ).toBeUndefined();
  });

  it("reports a top-level proxy error string (SSE parse failure)", () => {
    expect(
      evaluateMcpInitializeResponse({ error: "Failed to parse SSE stream" }),
    ).toBe("Failed to parse SSE stream");
  });

  it("reports a JSON-RPC error with code and message", () => {
    expect(
      evaluateMcpInitializeResponse({
        jsonrpc: "2.0",
        id: MCP_INIT_ID,
        error: { code: -32001, message: "Unauthorized" },
      }),
    ).toBe("-32001: Unauthorized");
  });

  it("rejects a non-MCP 2xx body, wrong id, or missing result", () => {
    expect(evaluateMcpInitializeResponse({ status: "ok" })).toMatch(
      /initialize result/i,
    );
    expect(
      evaluateMcpInitializeResponse({
        jsonrpc: "2.0",
        id: "other",
        result: {},
      }),
    ).toMatch(/initialize result/i);
    expect(
      evaluateMcpInitializeResponse({ jsonrpc: "2.0", id: MCP_INIT_ID }),
    ).toMatch(/initialize result/i);
  });
});

describe("mcpInitializeExtensionEvidence", () => {
  it("advertised when the extension key is present", () => {
    expect(
      mcpInitializeExtensionEvidence({
        jsonrpc: "2.0",
        id: MCP_INIT_ID,
        result: { capabilities: { extensions: { [XAA_MCP_EXTENSION]: {} } } },
      }),
    ).toBe("advertised");
  });

  it("not_advertised when capabilities exist without the extension", () => {
    expect(
      mcpInitializeExtensionEvidence({
        jsonrpc: "2.0",
        id: MCP_INIT_ID,
        result: { capabilities: { extensions: {} } },
      }),
    ).toBe("not_advertised");
  });

  it("unknown when there is no parseable capabilities object", () => {
    expect(mcpInitializeExtensionEvidence({ status: "ok" })).toBe("unknown");
    expect(mcpInitializeExtensionEvidence(ok)).toBe("unknown");
  });
});
