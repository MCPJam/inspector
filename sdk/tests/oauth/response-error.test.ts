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

  // Neither capped nor scanned here: both cost a pass over a body that can be
  // megabytes, and the redactor downstream has to see the text whole.
  it("returns the field as-is apart from trimming", () => {
    expect(extractResponseErrorReason("x".repeat(5_000))).toHaveLength(5_000);
    expect(
      extractResponseErrorReason("  Bad Request\n  at Server.handle  ")
    ).toBe("Bad Request\n  at Server.handle");
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

  it("collapses newlines so the flow error stays one line", () => {
    expect(
      describeAuthenticatedRequestFailure({
        status: 400,
        statusText: "Bad Request",
        body: "Bad Request\n  at Server.handle (server.js:12)",
      })
    ).toBe(
      "Authenticated request failed: 400 Bad Request: Bad Request at Server.handle (server.js:12)"
    );
  });

  it("caps the reason so an HTML error page cannot become the message", () => {
    const message = describeAuthenticatedRequestFailure({
      status: 400,
      statusText: "Bad Request",
      body: "x".repeat(5_000),
    });

    expect(message).toBe(
      `Authenticated request failed: 400 Bad Request: ${"x".repeat(300)}`
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

  // The two shapes `sanitizeTraceErrorMessage` closes only when it knows the
  // text was cut — a JSON value and a URL userinfo both need their closing
  // delimiter to match. Capping the reason before handing it over hid that cut
  // from the sanitizer, so the delimiter fell outside the reason and the secret
  // prefix survived. The sanitizer now owns both caps.
  // Both values start before the 300-character reason cap and run past it, so
  // the delimiter that terminates them is outside the cap while a long raw
  // prefix is inside it.
  it("redacts a JSON credential whose closing quote falls past the reason cap", () => {
    const filler = "context ".repeat(28); // 224 chars
    const secret = `SECRET${"0123456789".repeat(6)}`; // value spans 242..308

    const message = describeAuthenticatedRequestFailure({
      status: 400,
      statusText: "Bad Request",
      body: { message: `${filler}"client_secret": "${secret}" rejected` },
    });

    // The bare prefix, not a long slice of it: a regression that leaks a
    // shorter fragment is still a leak, and a longer needle would miss it.
    expect(message).not.toContain("SECRET");
  });

  it("redacts URL userinfo whose closing @ falls past the reason cap", () => {
    const filler = "context ".repeat(28); // 224 chars
    const password = `PASSWORD${"0123456789".repeat(7)}`; // `@` lands at 315

    const message = describeAuthenticatedRequestFailure({
      status: 400,
      statusText: "Bad Request",
      body: `${filler}https://user:${password}@example.test/token failed`,
    });

    expect(message).not.toContain("PASSWORD");
  });
});
