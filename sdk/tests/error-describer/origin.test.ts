import { describe, expect, it } from "vitest";
import {
  describeAsSlug,
  describeError,
  ERROR_CATALOG,
  isNormalizedError,
  originOf,
  type ErrorOrigin,
} from "../../src/error-describer/index.js";

const ORIGINS: ErrorOrigin[] = [
  "user_server",
  "user_config",
  "mcpjam",
  "ambiguous",
];

function makeError(message: string, extras: Record<string, unknown> = {}) {
  const err = new Error(message) as Error & Record<string, unknown>;
  Object.assign(err, extras);
  return err;
}

describe("origin — catalog coverage", () => {
  // The field is optional on the published type so external callers can still
  // construct an entry; inside this repo it is required, and this is what
  // makes that true. A new slug with no origin row fails here.
  it("every catalog entry declares a valid origin", () => {
    for (const [slug, entry] of Object.entries(ERROR_CATALOG)) {
      expect(ORIGINS, `entry ${slug}`).toContain(entry.origin);
    }
  });

  it("classifies something into every bucket", () => {
    const seen = new Set(
      Object.values(ERROR_CATALOG).map((entry) => entry.origin),
    );
    for (const origin of ORIGINS) {
      expect(seen, `no slug is ${origin}`).toContain(origin);
    }
  });
});

describe("origin — the decisions that carry consequences", () => {
  const CASES: Array<[string, ErrorOrigin]> = [
    // Reached their server; the answer was the problem.
    ["jsonrpc/internal_error", "user_server"],
    ["jsonrpc/parse_error", "user_server"],
    ["transport/socket_hang_up", "user_server"],
    // The tool name came from the user's server, so renaming happens there.
    ["provider/invalid_tool_name", "user_server"],
    // Wrong address / missing or bad credentials.
    ["transport/econnrefused", "user_config"],
    ["transport/enotfound", "user_config"],
    ["auth/http_401", "user_config"],
    ["oauth/invalid_grant", "user_config"],
    // Despite living under `sdk/`, this one is a user toggle: stateless on a
    // stdio server.
    ["sdk/stateless_requires_http", "user_config"],
    // Ours.
    ["sdk/not_yet_supported_in_stateless", "mcpjam"],
    // Envelope-level: MCPJam builds the envelope, so a systematic
    // serialization bug of ours lands here. Filing it as the user's would
    // make the one class of bug that affects everyone the class we never see.
    ["jsonrpc/invalid_request", "ambiguous"],
    ["jsonrpc/header_mismatch", "ambiguous"],
    // Either peer can drop or time out.
    ["jsonrpc/connection_closed", "ambiguous"],
    ["transport/etimedout", "ambiguous"],
    // Every unrecognized failure from an arbitrary user server lands here.
    // Marking it `mcpjam` would rebuild the paging noise this field removes.
    ["internal/unknown", "ambiguous"],
  ];

  it.each(CASES)("%s is %s", (slug, expected) => {
    expect(ERROR_CATALOG[slug].origin).toBe(expected);
  });
});

describe("origin — credential ownership override", () => {
  it("keeps a 401 with the user when nothing says otherwise", () => {
    const normalized = describeError(makeError("HTTP 401 Unauthorized"));

    expect(normalized.slug).toBe("auth/http_401");
    expect(originOf(normalized)).toBe("user_config");
  });

  it("moves a 401 to MCPJam when MCPJam holds the credential", () => {
    const normalized = describeError(makeError("HTTP 401 Unauthorized"), {
      credentialOwner: "mcpjam",
    });

    expect(originOf(normalized)).toBe("mcpjam");
  });

  it("leaves an explicit user owner alone", () => {
    const normalized = describeError(makeError("HTTP 401 Unauthorized"), {
      credentialOwner: "user",
    });

    expect(originOf(normalized)).toBe("user_config");
  });

  it("does not reassign failures that have nothing to do with a credential", () => {
    // A refused port is not about who owns the token, so a managed-credential
    // caller must not turn a user's dead server into an MCPJam page.
    const normalized = describeError(
      makeError("connect ECONNREFUSED 127.0.0.1:9999", {
        code: "ECONNREFUSED",
      }),
      { credentialOwner: "mcpjam" },
    );

    expect(normalized.slug).toBe("transport/econnrefused");
    expect(originOf(normalized)).toBe("user_config");
  });

  it("applies the same override through describeAsSlug", () => {
    // The chat route knows a 401 came from a provider, not an MCP server, and
    // whether the key was managed — both facts arrive this way.
    expect(originOf(describeAsSlug("provider/auth_error"))).toBe("user_config");
    expect(
      originOf(
        describeAsSlug("provider/auth_error", undefined, {
          credentialOwner: "mcpjam",
        }),
      ),
    ).toBe("mcpjam");
  });
});

describe("originOf — reading across versions", () => {
  it("defaults a missing origin to ambiguous rather than guessing", () => {
    expect(originOf(undefined)).toBe("ambiguous");
    expect(originOf(null)).toBe("ambiguous");
    expect(originOf({})).toBe("ambiguous");
  });

  it("returns the declared origin when present", () => {
    expect(originOf({ origin: "mcpjam" })).toBe("mcpjam");
  });

  it("accepts a normalized error that predates the field", () => {
    // An older server's payload has no `origin`. It must still pass the wire
    // guard — requiring the field there would reject every such response.
    const { origin: _dropped, ...withoutOrigin } = describeError(
      makeError("boom"),
    );

    expect(isNormalizedError(withoutOrigin)).toBe(true);
    expect(originOf(withoutOrigin)).toBe("ambiguous");
  });
});
