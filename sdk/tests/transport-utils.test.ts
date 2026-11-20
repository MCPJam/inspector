import { describe, expect, it } from "vitest";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildRequestInit } from "../src/mcp-client-manager/transport-utils.js";

describe("buildRequestInit (#3453)", () => {
  it("lets the shipped client transport set the negotiated protocol version without comma-joining", async () => {
    const requestInit = buildRequestInit(undefined, {
      headers: { "MCP-Protocol-Version": "2026-07-28" },
    });

    // The protocol-version key keeps its caller spelling; the dedupe only
    // handles collisions introduced by the requestInit itself.
    expect(requestInit?.headers).toEqual({
      "MCP-Protocol-Version": "2026-07-28",
    });

    const transport = new StreamableHTTPClientTransport(
      new URL("https://example.com/mcp"),
      { requestInit },
    );
    (transport as unknown as { _protocolVersion: string })._protocolVersion =
      "2025-11-25";

    const commonHeaders = await (
      transport as unknown as { _commonHeaders: () => Promise<Headers> }
    )._commonHeaders();

    // @modelcontextprotocol/client uses Headers.set, which replaces the value
    // regardless of casing; no "2025-11-25, 2026-07-28" comma join can form.
    expect(commonHeaders.get("mcp-protocol-version")).toBe("2025-11-25");
  });

  it("deduplicates colliding header names case-insensitively with later values winning", async () => {
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

    // Verify against the transport we actually ship, not the v1 SDK.
    const transport = new StreamableHTTPClientTransport(
      new URL("https://example.com/mcp"),
      { requestInit },
    );
    const commonHeaders = await (
      transport as unknown as { _commonHeaders: () => Promise<Headers> }
    )._commonHeaders();
    expect(commonHeaders.get("x-custom")).toBe("second");
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

  it("preserves a caller's auth regardless of casing when an accessToken is also supplied", () => {
    for (const casing of ["AUTHORIZATION", "Authorization", "authorization"]) {
      const requestInit = buildRequestInit("my-access-token", {
        headers: { [casing]: "Bearer caller-token", "X-Test": "value" },
      });

      expect(requestInit?.headers).toEqual({
        Authorization: "Bearer caller-token",
        "X-Test": "value",
      });
    }
  });

  it("keeps the last caller Authorization value when several casings collide and an accessToken is set", () => {
    const requestInit = buildRequestInit("my-access-token", {
      headers: {
        authorization: "Bearer stale",
        Authorization: "Bearer current",
        "X-Test": "value",
      },
    });

    // Later values win, matching deduplicateRequestHeaders on the no-token path.
    expect(requestInit?.headers).toEqual({
      Authorization: "Bearer current",
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
