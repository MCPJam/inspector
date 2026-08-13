import {
  describeAuthenticatedRequestFailure,
  extractResponseErrorReason,
} from "../../src/oauth/state-machines/shared/response-error.js";

describe("extractResponseErrorReason", () => {
  it("reads a JSON-RPC error message, the shape an MCP server rejects with", () => {
    expect(
      extractResponseErrorReason({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32600, message: "Mcp-Session-Id header is required" },
      })
    ).toBe("Mcp-Session-Id header is required");
  });

  it("reads a plain-text body, what a server behind a gateway usually returns", () => {
    expect(
      extractResponseErrorReason("Bad Request: server not initialized")
    ).toBe("Bad Request: server not initialized");
  });

  it("pairs an OAuth error code with its description", () => {
    expect(
      extractResponseErrorReason({
        error: "invalid_token",
        error_description: "The access token expired",
      })
    ).toBe("invalid_token: The access token expired");
  });

  it("falls back to a lone message field", () => {
    expect(extractResponseErrorReason({ message: "no tools registered" })).toBe(
      "no tools registered"
    );
  });

  it("returns undefined when the body carries no reason, so no empty suffix is appended", () => {
    expect(extractResponseErrorReason(undefined)).toBeUndefined();
    expect(extractResponseErrorReason("")).toBeUndefined();
    expect(extractResponseErrorReason("   ")).toBeUndefined();
    expect(extractResponseErrorReason({ result: {} })).toBeUndefined();
    expect(extractResponseErrorReason([{ error: "nope" }])).toBeUndefined();
  });

  it("treats a whitespace-only field as absent in every shape", () => {
    // OAuth pair: a blank description must not compose "invalid_token: ".
    expect(
      extractResponseErrorReason({
        error: "invalid_token",
        error_description: "  ",
      })
    ).toBe("invalid_token");
    // Generic: nothing left to say once the lone field is blank.
    expect(extractResponseErrorReason({ message: "\n\t " })).toBeUndefined();
    expect(
      extractResponseErrorReason({
        error_type: "invalid_request",
        error_message: " ",
      })
    ).toBeUndefined();
    // JSON-RPC: a blank nested message falls through rather than reporting "".
    expect(
      extractResponseErrorReason({ error: { code: -32600, message: "   " } })
    ).toBeUndefined();
  });

  it("prefers a field that says something over an earlier blank one", () => {
    expect(
      extractResponseErrorReason({
        error_message: "  ",
        message: "session expired",
      })
    ).toBe("session expired");
  });

  it("collapses newlines so the flow error stays one line", () => {
    expect(
      extractResponseErrorReason(
        "Bad Request\n  at Server.handle (server.js:12)"
      )
    ).toBe("Bad Request at Server.handle (server.js:12)");
  });

  it("caps the reason so an HTML error page cannot become the message", () => {
    const reason = extractResponseErrorReason("x".repeat(5_000));
    expect(reason).toHaveLength(300);
  });
});

describe("describeAuthenticatedRequestFailure", () => {
  it("appends the server's reason to the status line", () => {
    expect(
      describeAuthenticatedRequestFailure({
        status: 400,
        statusText: "Bad Request",
        body: { error: { code: -32600, message: "Missing protocol version" } },
      })
    ).toBe(
      "Authenticated request failed: 400 Bad Request: Missing protocol version"
    );
  });

  it("keeps the bare status line when the body explains nothing", () => {
    expect(
      describeAuthenticatedRequestFailure({
        status: 400,
        statusText: "Bad Request",
        body: undefined,
      })
    ).toBe("Authenticated request failed: 400 Bad Request");
  });

  it("redacts a token the server echoed back, keeping the diagnostic wording", () => {
    const message = describeAuthenticatedRequestFailure({
      status: 401,
      statusText: "Unauthorized",
      body: {
        error: "invalid_token",
        error_description:
          "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def was rejected",
      },
    });

    expect(message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(message).toContain("invalid_token");
    expect(message).toContain("was rejected");
  });
});
