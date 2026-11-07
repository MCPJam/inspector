import { describe, expect, it } from "vitest";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildRequestInit } from "../src/mcp-client-manager/transport-utils.js";

describe("buildRequestInit (#3453)", () => {
  it("normalizes MCP-Protocol-Version to lowercase so it overrides SDK transport defaults", async () => {
    const requestInit = buildRequestInit(undefined, {
      headers: { "MCP-Protocol-Version": "2026-07-28" },
    });

    expect(requestInit?.headers).toEqual({
      "mcp-protocol-version": "2026-07-28",
    });

    // In @modelcontextprotocol/sdk, StreamableHTTPClientTransport._commonHeaders spreads:
    // new Headers({ ...headers, ...extraHeaders }) where headers has lowercase 'mcp-protocol-version'.
    // If requestInit.headers has canonical casing 'MCP-Protocol-Version', new Headers receives both keys
    // and comma-joins them into '2025-11-25, 2026-07-28' (breaking connect with 502/400).
    // Lowercase 'mcp-protocol-version' cleanly replaces the default without duplicates.
    const transport = new StreamableHTTPClientTransport(
      new URL("https://example.com/mcp"),
      { requestInit },
    );
    // Simulate negotiated protocol version set on transport by client
    (transport as unknown as { _protocolVersion: string })._protocolVersion =
      "2025-11-25";

    const commonHeaders = await (
      transport as unknown as { _commonHeaders: () => Promise<Headers> }
    )._commonHeaders();

    expect(commonHeaders.get("mcp-protocol-version")).toBe("2026-07-28");
  });

  it("deduplicates colliding header names case-insensitively with later values winning", () => {
    const requestInit = buildRequestInit(undefined, {
      headers: {
        "x-custom": "first",
        "X-Custom": "second",
        "X-Other": "kept",
      },
    });

    expect(requestInit?.headers).toEqual({
      "X-Custom": "second",
      "X-Other": "kept",
    });
    expect(new Headers(requestInit?.headers).get("x-custom")).toBe("second");
  });

  it("merges accessToken into Authorization header and deduplicates lowercase authorization", () => {
    const requestInit = buildRequestInit("my-access-token", {
      headers: {
        authorization: "Bearer old-token",
        "X-Test": "value",
      },
    });

    // Caller-provided auth is preserved; lowercase authorization key is removed
    expect(requestInit?.headers).toEqual({
      Authorization: "Bearer old-token",
      "X-Test": "value",
    });
  });

  it("injects Bearer accessToken when no Authorization header was provided", () => {
    const requestInit = buildRequestInit("new-token", {
      headers: { "X-Test": "value" },
    });

    expect(requestInit?.headers).toEqual({
      Authorization: "Bearer new-token",
      "X-Test": "value",
    });
  });

  it("returns requestInit untouched when neither accessToken nor requestInit.headers is present", () => {
    const requestInit = buildRequestInit(undefined, { method: "POST" });
    expect(requestInit).toEqual({ method: "POST" });
  });

  it("returns undefined when both accessToken and requestInit are undefined", () => {
    const requestInit = buildRequestInit(undefined, undefined);
    expect(requestInit).toBeUndefined();
  });
});
