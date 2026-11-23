import { describe, expect, it } from "vitest";
import { readModernVersionRefusal } from "../src/mcp-client-manager/errors.js";
import { ModernProtocolVersionRefused } from "../src/mcp-client-manager/index.js";

/**
 * `UnsupportedProtocolVersionError` by shape, not by import: the app resolves
 * `@modelcontextprotocol/client` to a different copy than the SDK does.
 */
function unsupportedVersionError(
  supported: string[],
  requested: string
): Error {
  return Object.assign(
    new Error(`Unsupported protocol version: ${requested}`),
    {
      name: "UnsupportedProtocolVersionError",
      supported,
      requested,
    }
  );
}

/** The transport error for an HTTP 400 whose body is a JSON-RPC error. */
function postError(code: number, data?: unknown): Error {
  return new Error(
    `Error POSTing to endpoint: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code, message: "refused", ...(data ? { data } : {}) },
    })}`
  );
}

describe("readModernVersionRefusal", () => {
  it("reads the versions off the error the client raises for -32022", () => {
    expect(
      readModernVersionRefusal(
        unsupportedVersionError(["2099-01-01"], "2026-07-28")
      )
    ).toEqual({ supported: ["2099-01-01"] });
  });

  it("reads them off the body of an HTTP 400", () => {
    expect(
      readModernVersionRefusal(
        postError(-32022, {
          supported: ["2026-07-28"],
          requested: "2025-11-25",
        })
      )
    ).toEqual({ supported: ["2026-07-28"] });
  });

  it("finds the refusal down the cause chain", () => {
    const wrapped = new Error("Version negotiation failed", {
      cause: new Error("probe failed", {
        cause: unsupportedVersionError(
          ["2099-01-01", "2025-06-18"],
          "2026-07-28"
        ),
      }),
    });
    expect(readModernVersionRefusal(wrapped)).toEqual({
      supported: ["2099-01-01", "2025-06-18"],
    });
  });

  it("reads the client's error by shape, whatever its class is called", () => {
    // The upstream client raises the -32022 as a `ProtocolError`. Only
    // `supported` plus `requested` mark it as the version refusal.
    const raised = Object.assign(new Error("Unsupported protocol version"), {
      name: "ProtocolError",
      code: -32022,
      supported: ["2099-01-01"],
      requested: "2026-07-28",
    });
    expect(readModernVersionRefusal(raised)).toEqual({
      supported: ["2099-01-01"],
    });
  });

  it("returns an empty list when the server named no version", () => {
    expect(readModernVersionRefusal(postError(-32022))).toEqual({
      supported: [],
    });
  });

  // None of these is the server's modern refusal, so none of them says the
  // server is a modern one. Each must leave the legacy fallback in place.
  it.each([
    [
      "a legacy initialize reply that names another version",
      new Error("Server's protocol version is not supported: 2025-06-18"),
    ],
    [
      "a pin the server did not offer",
      Object.assign(
        new Error(
          "Version negotiation failed: the server did not offer pinned protocol version 2026-07-28 via server/discover"
        ),
        { code: "ERA_NEGOTIATION_FAILED" }
      ),
    ],
    ["another JSON-RPC error in a 400 body", postError(-32600)],
    [
      "an HTTP error with no JSON body",
      new Error("Error POSTing to endpoint (HTTP 405)"),
    ],
    ["a network failure", new TypeError("fetch failed")],
    ["nothing at all", undefined],
  ])("does not match %s", (_label, error) => {
    expect(readModernVersionRefusal(error)).toBeUndefined();
  });
});

describe("ModernProtocolVersionRefused", () => {
  it("names the server and what it offers", () => {
    const cause = unsupportedVersionError(["2099-01-01"], "2026-07-28");
    const error = new ModernProtocolVersionRefused("my-server", {
      cause,
      supportedVersions: ["2099-01-01"],
    });

    expect(error.name).toBe("ModernProtocolVersionRefused");
    expect(error.message).toBe(
      `MCP server "my-server" doesn't support an MCP protocol version this client speaks. It offers 2099-01-01.`
    );
    expect(error.supportedVersions).toEqual(["2099-01-01"]);
    expect(error.cause).toBe(cause);
  });

  it("leaves the offer out when the server named none", () => {
    expect(new ModernProtocolVersionRefused("my-server").message).toBe(
      `MCP server "my-server" doesn't support an MCP protocol version this client speaks.`
    );
  });
});
