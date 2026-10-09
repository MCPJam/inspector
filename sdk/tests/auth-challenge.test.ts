/**
 * Mid-session sign-in challenges: recognition is host-agnostic and maximal,
 * and the per-host policy decides what to do with what was recognized.
 */

import { InsufficientScopeError } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
  AUTH_CHALLENGE_LIMITS,
  authChallengePolicyFrom,
  decideAuthChallengeAction,
  describeAuthChallengeDecision,
  parseAuthChallengeSignal,
  parseChallengeHeader,
  parseToolResultAuthChallenge,
  resolveToolSecuritySchemes,
  type AuthChallengePolicy,
  type AuthChallengeSignal,
  type ToolSecuritySchemeResolution,
} from "../src/mcp-client-manager/auth-challenge.js";
import {
  attachAuthChallenge,
  extractAuthChallenge,
} from "../src/mcp-client-manager/errors.js";
import { ToolDeclarationCapture } from "../src/mcp-client-manager/tool-declaration-capture.js";

const PRM = "https://orders.example.com/.well-known/oauth-protected-resource/mcp";

describe("parseChallengeHeader", () => {
  it("reads every field of a full Bearer challenge", () => {
    const signal = parseChallengeHeader(
      `Bearer error="invalid_token", error_description="Sign in", resource_metadata="${PRM}", scope="orders:read"`
    );
    expect(signal).toEqual({
      source: "http_401",
      error: "invalid_token",
      errorDescription: "Sign in",
      requiredScope: "orders:read",
      resourceMetadataUrl: PRM,
      raw: `Bearer error="invalid_token", error_description="Sign in", resource_metadata="${PRM}", scope="orders:read"`,
      facets: {
        challengeHeader: "bearer",
        hasResourceMetadata: true,
        hasScope: true,
        hasErrorParams: true,
      },
    });
  });

  it("recognizes a 401 with no header at all", () => {
    expect(parseChallengeHeader(undefined)).toEqual({
      source: "http_401",
      facets: {
        challengeHeader: "none",
        hasResourceMetadata: false,
        hasScope: false,
        hasErrorParams: false,
      },
    });
    expect(parseChallengeHeader("   ").facets.challengeHeader).toBe("none");
  });

  it("recognizes a bare Bearer with no parameters", () => {
    const signal = parseChallengeHeader("Bearer");
    expect(signal.facets).toEqual({
      challengeHeader: "bearer",
      hasResourceMetadata: false,
      hasScope: false,
      hasErrorParams: false,
    });
  });

  it("records a non-Bearer scheme as other-scheme", () => {
    expect(parseChallengeHeader('Basic realm="x"').facets.challengeHeader).toBe(
      "other-scheme"
    );
  });

  it("picks the actionable challenge among several", () => {
    const signal = parseChallengeHeader(
      `Basic realm="x", Bearer realm="mcp", Bearer error="invalid_token", scope="a b"`
    );
    expect(signal.error).toBe("invalid_token");
    expect(signal.requiredScope).toBe("a b");
  });

  it("does not credit a Bearer challenge spoofed inside a quoted value", () => {
    const signal = parseChallengeHeader(
      `Basic realm="a, Bearer error=\\"invalid_token\\", resource_metadata=\\"https://evil.example\\""`
    );
    expect(signal.facets.challengeHeader).toBe("other-scheme");
    expect(signal.resourceMetadataUrl).toBeUndefined();
  });

  it("caps oversized values", () => {
    const long = "x".repeat(10_000);
    const signal = parseChallengeHeader(
      `Bearer error_description="${long}", scope="${long}"`
    );
    expect(signal.errorDescription!.length).toBe(
      AUTH_CHALLENGE_LIMITS.fieldChars
    );
    expect(signal.requiredScope!.length).toBe(AUTH_CHALLENGE_LIMITS.fieldChars);
    expect(signal.raw!.length).toBe(AUTH_CHALLENGE_LIMITS.rawChars);
  });

  it("prefers the insufficient_scope challenge on a 403", () => {
    const signal = parseChallengeHeader(
      `Bearer error="invalid_token", Bearer error="insufficient_scope", scope="orders:write"`,
      "http_403_insufficient_scope"
    );
    expect(signal.error).toBe("insufficient_scope");
    expect(signal.requiredScope).toBe("orders:write");
  });
});

describe("parseToolResultAuthChallenge", () => {
  const challenge = `Bearer resource_metadata="${PRM}", error="insufficient_scope", error_description="You need to login to continue"`;

  it("reads OpenAI's array form", () => {
    const signal = parseToolResultAuthChallenge({
      isError: true,
      content: [{ type: "text", text: "Sign in" }],
      _meta: { "mcp/www_authenticate": [challenge] },
    });
    expect(signal).toMatchObject({
      source: "tool_result_meta",
      error: "insufficient_scope",
      errorDescription: "You need to login to continue",
      resourceMetadataUrl: PRM,
      facets: {
        challengeHeader: "bearer",
        hasResourceMetadata: true,
        hasErrorParams: true,
      },
    });
  });

  it("reads the string form", () => {
    expect(
      parseToolResultAuthChallenge({
        isError: true,
        _meta: { "mcp/www_authenticate": challenge },
      })?.resourceMetadataUrl
    ).toBe(PRM);
  });

  it("requires isError: true", () => {
    expect(
      parseToolResultAuthChallenge({
        content: [],
        _meta: { "mcp/www_authenticate": [challenge] },
      })
    ).toBeUndefined();
    expect(
      parseToolResultAuthChallenge({
        isError: "true",
        _meta: { "mcp/www_authenticate": [challenge] },
      })
    ).toBeUndefined();
  });

  it("ignores results with no usable challenge", () => {
    expect(parseToolResultAuthChallenge({ isError: true })).toBeUndefined();
    expect(
      parseToolResultAuthChallenge({
        isError: true,
        _meta: { "mcp/www_authenticate": [42, ""] },
      })
    ).toBeUndefined();
    expect(parseToolResultAuthChallenge(null)).toBeUndefined();
  });

  it("records missing error_description in the facets", () => {
    const signal = parseToolResultAuthChallenge({
      isError: true,
      _meta: {
        "mcp/www_authenticate": [`Bearer error="insufficient_scope"`],
      },
    });
    expect(signal?.facets.hasErrorParams).toBe(false);
  });
});

describe("parseAuthChallengeSignal", () => {
  it("narrows an untrusted wire value and drops unknown fields", () => {
    expect(
      parseAuthChallengeSignal({
        source: "http_401",
        requiredScope: "a",
        effectiveAuth: "xaa",
        injected: "<script>",
        facets: { challengeHeader: "bearer", hasScope: true },
      })
    ).toEqual({
      source: "http_401",
      requiredScope: "a",
      effectiveAuth: "xaa",
      facets: {
        challengeHeader: "bearer",
        hasResourceMetadata: false,
        hasScope: true,
        hasErrorParams: false,
      },
    });
    expect(parseAuthChallengeSignal({ source: "other" })).toBeUndefined();
    expect(
      parseAuthChallengeSignal({
        source: "http_401",
        effectiveAuth: "root",
        facets: {},
      })?.effectiveAuth
    ).toBeUndefined();
  });
});

describe("resolveToolSecuritySchemes", () => {
  it("follows tool, then _meta, then server default", () => {
    expect(
      resolveToolSecuritySchemes({
        declaration: {
          securitySchemes: [{ type: "oauth2", scopes: ["a"] }],
          _meta: { securitySchemes: [{ type: "noauth" }] },
        },
      })
    ).toEqual({
      schemes: [{ type: "oauth2", scopes: ["a"] }],
      source: "tool",
    });
    expect(
      resolveToolSecuritySchemes({
        declaration: { _meta: { securitySchemes: [{ type: "noauth" }] } },
      }).source
    ).toBe("tool-meta");
    expect(
      resolveToolSecuritySchemes({
        declaration: {},
        serverDefault: [{ type: "oauth2" }],
      }).source
    ).toBe("server-default");
  });

  it("never reads a tool that declares nothing as 'no OAuth'", () => {
    expect(resolveToolSecuritySchemes({ declaration: {} })).toEqual({
      schemes: [],
      source: "unresolved",
    });
    expect(resolveToolSecuritySchemes({})).toEqual({
      schemes: [],
      source: "unresolved",
    });
    expect(
      resolveToolSecuritySchemes({ declaration: {}, serverDefault: null })
    ).toEqual({ schemes: [], source: "none" });
  });

  it("keeps an explicit empty array as a declaration", () => {
    expect(
      resolveToolSecuritySchemes({ declaration: { securitySchemes: [] } })
    ).toEqual({ schemes: [], source: "tool" });
  });
});

function signal(
  source: AuthChallengeSignal["source"],
  facets: Partial<AuthChallengeSignal["facets"]> = {}
): AuthChallengeSignal {
  return {
    source,
    facets: {
      challengeHeader: "bearer",
      hasResourceMetadata: true,
      hasScope: true,
      hasErrorParams: true,
      ...facets,
    },
  };
}

const OAUTH2: ToolSecuritySchemeResolution = {
  schemes: [{ type: "oauth2" }],
  source: "tool",
};
const NOAUTH: ToolSecuritySchemeResolution = {
  schemes: [{ type: "noauth" }],
  source: "tool",
};
const UNRESOLVED: ToolSecuritySchemeResolution = {
  schemes: [],
  source: "unresolved",
};

describe("decideAuthChallengeAction", () => {
  const CLAUDE: AuthChallengePolicy = {
    unauthorizedChallengeTrigger: "bearer-header",
  };
  const CLAUDE_CODE: AuthChallengePolicy = {
    unauthorizedChallenge: "notify",
    unauthorizedChallengeTrigger: "bearer-header",
  };
  const CHATGPT: AuthChallengePolicy = { toolResultAuthChallenge: "prompt" };

  it.each([
    // [label, signal, policy, schemes, expected action, expected reason]
    ["spec default, Bearer 401", signal("http_401"), undefined, undefined, "prompt", "honored"],
    ["spec default, headerless 401", signal("http_401", { challengeHeader: "none" }), undefined, undefined, "prompt", "honored"],
    ["Claude, Bearer 401", signal("http_401"), CLAUDE, undefined, "prompt", "honored"],
    ["Claude, headerless 401", signal("http_401", { challengeHeader: "none" }), CLAUDE, undefined, "passthrough", "missing-bearer-header"],
    ["Claude, other scheme", signal("http_401", { challengeHeader: "other-scheme" }), CLAUDE, undefined, "passthrough", "missing-bearer-header"],
    ["Claude Code, Bearer 401", signal("http_401"), CLAUDE_CODE, undefined, "notify", "honored"],
    ["resource-metadata trigger without pointer", signal("http_401", { hasResourceMetadata: false }), { unauthorizedChallengeTrigger: "resource-metadata" }, undefined, "passthrough", "missing-resource-metadata"],
    ["401 passthrough host", signal("http_401"), { unauthorizedChallenge: "passthrough" }, undefined, "passthrough", "not-honored"],
    ["spec default, _meta", signal("tool_result_meta"), undefined, OAUTH2, "passthrough", "not-honored"],
    ["Claude, _meta", signal("tool_result_meta"), CLAUDE, OAUTH2, "passthrough", "not-honored"],
    ["ChatGPT, _meta + oauth2", signal("tool_result_meta"), CHATGPT, OAUTH2, "prompt", "honored"],
    ["ChatGPT, _meta + noauth", signal("tool_result_meta"), CHATGPT, NOAUTH, "passthrough", "missing-oauth2-scheme"],
    ["ChatGPT, _meta + unresolved schemes", signal("tool_result_meta"), CHATGPT, UNRESOLVED, "notify", "schemes-unresolved"],
    ["ChatGPT, _meta without error_description", signal("tool_result_meta", { hasErrorParams: false }), CHATGPT, OAUTH2, "passthrough", "missing-error-params"],
    ["ChatGPT trigger oauth2-scheme only", signal("tool_result_meta", { hasErrorParams: false }), { ...CHATGPT, toolResultAuthChallengeTrigger: "oauth2-scheme" }, OAUTH2, "prompt", "honored"],
    ["trigger any ignores schemes", signal("tool_result_meta"), { ...CHATGPT, toolResultAuthChallengeTrigger: "any" }, NOAUTH, "prompt", "honored"],
    ["403 step-up is always honored", signal("http_403_insufficient_scope"), { unauthorizedChallenge: "passthrough" }, undefined, "prompt", "honored"],
  ] as const)("%s", (_label, input, policy, schemes, action, reason) => {
    expect(decideAuthChallengeAction(input, policy, schemes)).toEqual({
      action,
      reason,
    });
  });

  it("explains every decision in developer copy", () => {
    const decision = decideAuthChallengeAction(signal("tool_result_meta"), CLAUDE, OAUTH2);
    expect(describeAuthChallengeDecision(signal("tool_result_meta"), decision, "Claude")).toContain(
      'Claude ignores _meta["mcp/www_authenticate"]'
    );
  });
});

describe("authChallengePolicyFrom", () => {
  it("reads only valid knob values off a profile", () => {
    expect(
      authChallengePolicyFrom({
        unauthorizedChallenge: "notify",
        unauthorizedChallengeTrigger: "bogus",
        toolResultAuthChallenge: "prompt",
        toolResultAuthChallengeTrigger: "oauth2-scheme",
        paginationTraversal: "first-page-only",
      })
    ).toEqual({
      unauthorizedChallenge: "notify",
      toolResultAuthChallenge: "prompt",
      toolResultAuthChallengeTrigger: "oauth2-scheme",
    });
    expect(authChallengePolicyFrom({})).toBeUndefined();
    expect(authChallengePolicyFrom(undefined)).toBeUndefined();
  });
});

describe("extractAuthChallenge", () => {
  it("finds a signal on SdkHttpError data through a cause chain", () => {
    const inner = Object.assign(new Error("HTTP 401"), {
      status: 401,
      data: { authChallenge: parseChallengeHeader('Bearer scope="a"') },
    });
    const outer = new Error("tool failed", { cause: inner });
    expect(extractAuthChallenge(outer)).toMatchObject({
      source: "http_401",
      requiredScope: "a",
    });
  });

  it("maps an InsufficientScopeError, even a scope-less one", () => {
    const scoped = new InsufficientScopeError({
      requiredScope: "orders:write",
    } as never);
    expect(extractAuthChallenge(scoped)).toMatchObject({
      source: "http_403_insufficient_scope",
      error: "insufficient_scope",
      requiredScope: "orders:write",
      facets: { challengeHeader: "bearer", hasScope: true },
    });
    const scopeless = new InsufficientScopeError({} as never);
    expect(extractAuthChallenge(scopeless)).toMatchObject({
      source: "http_403_insufficient_scope",
      facets: { hasScope: false, hasResourceMetadata: false },
    });
  });

  it("finds an attached challenge, and never overwrites one", () => {
    const error = Object.assign(new Error("Unauthorized"), {
      name: "UnauthorizedError",
    });
    expect(extractAuthChallenge(error)).toBeUndefined();
    attachAuthChallenge(error, parseChallengeHeader('Bearer scope="first"'));
    attachAuthChallenge(error, parseChallengeHeader('Bearer scope="second"'));
    expect(extractAuthChallenge(error)?.requiredScope).toBe("first");
  });

  it("returns undefined for an unrelated error", () => {
    expect(extractAuthChallenge(new Error("nope"))).toBeUndefined();
    expect(extractAuthChallenge("string")).toBeUndefined();
  });
});

describe("ToolDeclarationCapture keeps securitySchemes", () => {
  it("survives the raw frame, top-level and under _meta", () => {
    const capture = new ToolDeclarationCapture();
    capture.observe({
      direction: "send",
      serverId: "s",
      message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    capture.observe({
      direction: "receive",
      serverId: "s",
      message: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            {
              name: "a",
              inputSchema: { type: "object" },
              securitySchemes: [{ type: "oauth2", scopes: ["x"] }],
            },
            {
              name: "b",
              inputSchema: { type: "object" },
              _meta: {
                securitySchemes: [{ type: "noauth" }],
                "openai/outputTemplate": "ui://b",
              },
            },
            { name: "c", inputSchema: { type: "object" } },
          ],
        },
      },
    });
    const tools = capture.read("s")!.tools;
    expect(tools[0].securitySchemes).toEqual([{ type: "oauth2", scopes: ["x"] }]);
    // Only the scheme array is kept from _meta, not the whole object.
    expect(tools[1]._meta).toEqual({ securitySchemes: [{ type: "noauth" }] });
    expect(tools[2]).not.toHaveProperty("securitySchemes");
    expect(tools[2]).not.toHaveProperty("_meta");
  });
});
