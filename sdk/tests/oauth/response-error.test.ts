import {
  describeAuthenticatedRequestFailure,
  describeTokenRequestFailure,
  extractResponseErrorReason,
  isAuthenticatedRequestFailure,
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
  it("marks its output as a target-server failure", () => {
    const message = describeAuthenticatedRequestFailure({
      status: 503,
      statusText: "Service Temporarily Unavailable",
      body: "<html><body>temporarily unavailable</body></html>",
    });

    expect(isAuthenticatedRequestFailure(message)).toBe(true);
    expect(
      isAuthenticatedRequestFailure(
        "Backend debug proxy error: 503 Service Temporarily Unavailable"
      )
    ).toBe(false);
    expect(
      isAuthenticatedRequestFailure(
        "Token request failed: 503 Service Temporarily Unavailable"
      )
    ).toBe(false);
  });

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

describe("describeTokenRequestFailure", () => {
  // The reported failure (INSPECTOR-CLIENT-239): the endpoint answered in a
  // shape RFC 6749 does not describe, so the old message interpolated an object
  // into a template literal and lost the one field that said what went wrong.
  it("reads a non-RFC-6749 nested error instead of rendering [object Object]", () => {
    const message = describeTokenRequestFailure({
      status: 400,
      statusText: "Bad Request",
      body: { error: { code: -32600, message: "code_verifier mismatch" } },
    });

    expect(message).toBe(
      "Token request failed: 400 Bad Request: code_verifier mismatch"
    );
    expect(message).not.toContain("[object Object]");
    expect(message).not.toContain("Unknown error");
  });

  it("pairs the OAuth error code with its description", () => {
    expect(
      describeTokenRequestFailure({
        status: 400,
        statusText: "Bad Request",
        body: {
          error: "invalid_grant",
          error_description: "Authorization code expired",
        },
      })
    ).toBe(
      "Token request failed: 400 Bad Request: invalid_grant: Authorization code expired"
    );
  });

  // The status is what stays actionable when the endpoint says nothing — the
  // old message dropped it whenever `body.error` was set, and printed a bare
  // "Unknown error" whenever it was not.
  it("keeps the status line when the body explains nothing", () => {
    expect(
      describeTokenRequestFailure({
        status: 502,
        statusText: "Bad Gateway",
        body: undefined,
      })
    ).toBe("Token request failed: 502 Bad Gateway");
  });

  it("redacts a credential the endpoint echoed back", () => {
    const message = describeTokenRequestFailure({
      status: 401,
      statusText: "Unauthorized",
      body: {
        error: "invalid_client",
        error_description:
          'rejected {"client_secret": "SECRETvalue0123456789"} for this client',
      },
    });

    expect(message).not.toContain("SECRETvalue");
    expect(message).toContain("invalid_client");
  });
});

// The reason phrase is the server's text too, so it gets the reason's
// treatment. RFC 9112 keeps it to one short line of visible characters, but the
// endpoint is the server under test and the value crosses a proxy before it
// reaches us — the status code beside it is the only part we can trust.
describe("describeResponseFailure status-phrase handling", () => {
  it("redacts a credential reflected in the reason phrase", () => {
    const message = describeTokenRequestFailure({
      status: 401,
      statusText:
        "Unauthorized - Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def",
      body: undefined,
    });

    expect(message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(message).toContain("401");
  });

  it("keeps a multiline phrase on one line", () => {
    const message = describeAuthenticatedRequestFailure({
      status: 500,
      statusText: "Internal Error\n  at Server.handle (server.js:12)",
      body: undefined,
    });

    expect(message).toBe(
      "Authenticated request failed: 500 Internal Error at Server.handle (server.js:12)"
    );
  });

  it("caps a phrase long enough to swamp the message", () => {
    const message = describeTokenRequestFailure({
      status: 400,
      statusText: "y".repeat(5_000),
      body: undefined,
    });

    expect(message).toBe(`Token request failed: 400 ${"y".repeat(300)}`);
  });

  // A proxied response can carry no phrase at all; printing the space anyway
  // left a message ending in one.
  it("drops an absent phrase instead of trailing a bare space", () => {
    expect(
      describeTokenRequestFailure({
        status: 502,
        statusText: "",
        body: undefined,
      })
    ).toBe("Token request failed: 502");

    expect(
      describeTokenRequestFailure({
        status: 502,
        statusText: undefined as unknown as string,
        body: { error: "temporarily_unavailable" },
      })
    ).toBe("Token request failed: 502: temporarily_unavailable");
  });
});
