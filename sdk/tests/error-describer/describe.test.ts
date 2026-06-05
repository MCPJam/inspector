import { describe, expect, it } from "vitest";
import {
  describeAsSlug,
  describeError,
  ERROR_CATALOG,
  extractNodeErrno,
  type NormalizedError,
} from "../../src/error-describer/index.js";
import { MCPAuthError } from "../../src/mcp-client-manager/errors.js";

function makeError(message: string, extras: Record<string, unknown> = {}) {
  const err = new Error(message) as Error & Record<string, unknown>;
  Object.assign(err, extras);
  return err;
}

describe("describeError — catalog completeness", () => {
  it("every catalog entry has the required surface", () => {
    for (const [slug, entry] of Object.entries(ERROR_CATALOG)) {
      expect(entry.slug, `entry ${slug}`).toBe(slug);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.oneLine.length).toBeGreaterThan(0);
      expect(entry.likelyCauses.length).toBeGreaterThan(0);
      expect(entry.nextSteps.length).toBeGreaterThan(0);
      expect(entry.docsAnchor.startsWith("/troubleshooting/error-codes#")).toBe(
        true,
      );
      expect(["info", "warning", "error"]).toContain(entry.severity);
    }
  });

  it("catalog covers >= 18 entries", () => {
    expect(Object.keys(ERROR_CATALOG).length).toBeGreaterThanOrEqual(18);
  });
});

type Case = {
  name: string;
  build: () => unknown;
  expectSlug: string;
  expectRawCode?: number | string;
};

const CASES: Case[] = [
  // JSON-RPC numeric
  {
    name: "-32700 parse error",
    build: () => makeError("Parse error", { code: -32700 }),
    expectSlug: "jsonrpc/parse_error",
    expectRawCode: -32700,
  },
  {
    name: "-32600 invalid request",
    build: () => makeError("Invalid request", { code: -32600 }),
    expectSlug: "jsonrpc/invalid_request",
    expectRawCode: -32600,
  },
  {
    name: "-32601 method not found",
    build: () => makeError("Method not found", { code: -32601 }),
    expectSlug: "jsonrpc/method_not_found",
    expectRawCode: -32601,
  },
  {
    name: "-32602 invalid params",
    build: () => makeError("Invalid params", { code: -32602 }),
    expectSlug: "jsonrpc/invalid_params",
    expectRawCode: -32602,
  },
  {
    name: "-32603 internal error",
    build: () => makeError("Internal error", { code: -32603 }),
    expectSlug: "jsonrpc/internal_error",
    expectRawCode: -32603,
  },
  {
    name: "-32000 connection closed",
    build: () => makeError("Connection closed", { code: -32000 }),
    expectSlug: "jsonrpc/connection_closed",
    expectRawCode: -32000,
  },
  {
    name: "-32001 request timeout",
    build: () => makeError("Request timed out", { code: -32001 }),
    expectSlug: "jsonrpc/request_timeout",
    expectRawCode: -32001,
  },
  {
    name: "-32001 header mismatch (inspector overload)",
    build: () =>
      makeError("MCP-Protocol-Version header mismatch", { code: -32001 }),
    expectSlug: "jsonrpc/header_mismatch",
    expectRawCode: -32001,
  },
  {
    name: "-32004 unsupported protocol version",
    build: () => makeError("Unsupported protocol version", { code: -32004 }),
    expectSlug: "jsonrpc/unsupported_protocol_version",
    expectRawCode: -32004,
  },
  {
    name: "-32042 url elicitation required",
    build: () => makeError("URL elicitation required", { code: -32042 }),
    expectSlug: "jsonrpc/url_elicitation_required",
    expectRawCode: -32042,
  },
  // Node errno
  {
    name: "ECONNREFUSED",
    build: () => makeError("connect ECONNREFUSED 127.0.0.1:9999", { code: "ECONNREFUSED" }),
    expectSlug: "transport/econnrefused",
    expectRawCode: "ECONNREFUSED",
  },
  {
    name: "ECONNRESET",
    build: () => makeError("socket reset", { code: "ECONNRESET" }),
    expectSlug: "transport/econnreset",
    expectRawCode: "ECONNRESET",
  },
  {
    name: "ETIMEDOUT",
    build: () => makeError("connect timeout", { code: "ETIMEDOUT" }),
    expectSlug: "transport/etimedout",
    expectRawCode: "ETIMEDOUT",
  },
  {
    name: "ENOTFOUND",
    build: () => makeError("getaddrinfo ENOTFOUND foo", { code: "ENOTFOUND" }),
    expectSlug: "transport/enotfound",
    expectRawCode: "ENOTFOUND",
  },
  {
    name: "EAI_AGAIN",
    build: () => makeError("Temporary failure", { code: "EAI_AGAIN" }),
    expectSlug: "transport/eai_again",
    expectRawCode: "EAI_AGAIN",
  },
  {
    name: "UND_ERR_SOCKET",
    build: () => makeError("socket terminated", { code: "UND_ERR_SOCKET" }),
    expectSlug: "transport/undici",
    expectRawCode: "UND_ERR_SOCKET",
  },
  {
    name: "fetch failed",
    build: () => new Error("fetch failed"),
    expectSlug: "transport/fetch_failed",
  },
  {
    name: "socket hang up",
    build: () => new Error("socket hang up"),
    expectSlug: "transport/socket_hang_up",
  },
  // Auth
  {
    name: "HTTP 401 statusCode",
    build: () => makeError("Unauthorized", { statusCode: 401 }),
    expectSlug: "auth/http_401",
    expectRawCode: 401,
  },
  {
    name: "HTTP 403 statusCode",
    build: () => makeError("Forbidden", { statusCode: 403 }),
    expectSlug: "auth/http_403",
    expectRawCode: 403,
  },
  {
    name: "401 in message",
    build: () => new Error("Server responded HTTP 401"),
    expectSlug: "auth/http_401",
  },
  {
    name: "OAuth refresh failed message",
    build: () => new Error("OAuth refresh token failed: invalid_grant"),
    expectSlug: "auth/oauth_refresh_failed",
  },
  {
    name: "Missing bearer",
    build: () => new Error("Missing or invalid bearer token"),
    expectSlug: "auth/missing_bearer",
  },
  // OAuth body
  {
    name: "oauth invalid_grant body",
    build: () => ({ body: { error: "invalid_grant", error_description: "Bad code" } }),
    expectSlug: "oauth/invalid_grant",
  },
  {
    name: "oauth invalid_client body",
    build: () => ({ data: { error: "invalid_client" } }),
    expectSlug: "oauth/invalid_client",
  },
  {
    name: "oauth redirect mismatch body",
    build: () => ({ error: "redirect_uri_mismatch" }),
    expectSlug: "oauth/redirect_mismatch",
  },
  {
    name: "oauth well-known unreachable",
    build: () =>
      new Error(".well-known/oauth-authorization-server unreachable"),
    expectSlug: "oauth/well_known_unreachable",
  },
  // Inspector sentinels
  {
    name: "NotYetSupportedInStateless sentinel",
    build: () => new Error("NotYetSupportedInStateless: resources/subscribe"),
    expectSlug: "sdk/not_yet_supported_in_stateless",
  },
  {
    name: "StatelessRequiresHttpTransport sentinel",
    build: () => new Error("StatelessRequiresHttpTransport"),
    expectSlug: "sdk/stateless_requires_http",
  },
  {
    name: "PaginatedToolHeaderDiscoveryUnsupported sentinel",
    build: () => new Error("PaginatedToolHeaderDiscoveryUnsupported"),
    expectSlug: "sdk/paginated_tool_header_discovery_unsupported",
  },
  // Provider
  {
    name: "Anthropic invalid tool name",
    build: () =>
      new Error('messages.tools.0: Invalid tool name "weird name with spaces"'),
    expectSlug: "provider/invalid_tool_name",
  },
];

describe("describeError — table-driven", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const out = describeError(c.build());
      expect(out.slug, JSON.stringify(out)).toBe(c.expectSlug);
      if (c.expectRawCode !== undefined) {
        expect(out.rawCode).toBe(c.expectRawCode);
      }
      expect(out.title.length).toBeGreaterThan(0);
      expect(out.rawMessage.length).toBeGreaterThan(0);
    });
  }
});

describe("describeError — fallback shapes (>= 8)", () => {
  const cases: Array<[string, unknown, string]> = [
    ["plain Error", new Error("something exploded"), "internal/unknown"],
    ["null", null, "internal/unknown"],
    ["undefined", undefined, "internal/unknown"],
    ["string thrown", "boom", "internal/unknown"],
    [
      "AbortError",
      Object.assign(new Error("aborted"), { name: "AbortError" }),
      "internal/unknown",
    ],
    [
      "OAuth body without error_description",
      { body: { error_description: "Bad" } },
      "internal/unknown",
    ],
    ["MCPAuthError", new MCPAuthError("token expired", 401), "auth/http_401"],
    [
      "hosted error envelope",
      { code: "INTERNAL_ERROR", message: "Hosted failure" },
      "internal/unknown",
    ],
    ["unknown numeric code", makeError("weird", { code: -42 }), "internal/unknown"],
    ["bare number", 42, "internal/unknown"],
  ];
  for (const [name, input, expectSlug] of cases) {
    it(name, () => {
      const out: NormalizedError = describeError(input);
      expect(out.slug).toBe(expectSlug);
      expect(out).toHaveProperty("rawMessage");
    });
  }
});

describe("describeError — redaction", () => {
  it("redacts bearer tokens from raw message", () => {
    const out = describeError(
      new Error("Authorization: Bearer abcdef.ghi.jkl failed"),
    );
    expect(out.rawMessage).not.toContain("abcdef.ghi.jkl");
    expect(out.rawMessage.toLowerCase()).toContain("redacted");
  });

  it("never throws on truly unusual input", () => {
    expect(() => describeError({ get code() { throw new Error("nope"); } })).not.toThrow();
  });
});

describe("extractNodeErrno — cause walking", () => {
  it("returns top-level code when present", () => {
    expect(extractNodeErrno({ code: "ECONNREFUSED" })).toBe("ECONNREFUSED");
  });

  it("walks one level of cause (undici fetch wrapping)", () => {
    // Reproduces Node's typical fetch-failed shape:
    // TypeError("fetch failed") with cause = SystemError carrying the errno.
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9999"), {
      code: "ECONNREFUSED",
    });
    const wrapper = Object.assign(new TypeError("fetch failed"), { cause });
    expect(extractNodeErrno(wrapper)).toBe("ECONNREFUSED");
  });

  it("walks multiple cause levels but stops at the depth bound", () => {
    const deep = Object.assign(new Error("inner"), { code: "ENOTFOUND" });
    const mid = Object.assign(new Error("mid"), { cause: deep });
    const outer = Object.assign(new TypeError("fetch failed"), { cause: mid });
    expect(extractNodeErrno(outer)).toBe("ENOTFOUND");
  });

  it("tolerates a self-referential cause without looping forever", () => {
    const err: { cause?: unknown } = {};
    err.cause = err;
    expect(() => extractNodeErrno(err)).not.toThrow();
    expect(extractNodeErrno(err)).toBeUndefined();
  });
});

describe("describeError — fetch failed surfaces specific transport slug", () => {
  it("classifies undici-wrapped ECONNREFUSED as transport/econnrefused", () => {
    // Before the cause-walking fix this fell through to the message-regex
    // fallback and produced the generic "fetch failed" slug, defeating the
    // entire point of the transport catalog for the #1 docs-chat query.
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9999"), {
      code: "ECONNREFUSED",
    });
    const wrapper = Object.assign(new TypeError("fetch failed"), { cause });
    const out = describeError(wrapper);
    expect(out.slug).toBe("transport/econnrefused");
    expect(out.rawCode).toBe("ECONNREFUSED");
  });
});

describe("describeAsSlug — explicit catalog pinning", () => {
  it("uses the requested slug when the caller has more context than the resolver", () => {
    // chat-v2's use case: an HTTP 401 from an LLM provider, where the
    // generic resolver would pick auth/http_401 (MCP server re-auth) but
    // the route knows it's a provider-key issue.
    const out = describeAsSlug(
      "provider/auth_error",
      Object.assign(new Error("Invalid API key"), { statusCode: 401 }),
    );
    expect(out.slug).toBe("provider/auth_error");
    expect(out.title).toBe(ERROR_CATALOG["provider/auth_error"].title);
    expect(out.rawMessage).toContain("Invalid API key");
  });

  it("falls back to internal/unknown for an unknown slug instead of throwing", () => {
    const out = describeAsSlug("not/in/catalog", new Error("nope"));
    expect(out.slug).toBe("internal/unknown");
    expect(out.rawMessage).toContain("nope");
  });

  it("accepts a missing error argument", () => {
    const out = describeAsSlug("provider/quota");
    expect(out.slug).toBe("provider/quota");
    expect(out.rawMessage).toBe("");
  });
});
