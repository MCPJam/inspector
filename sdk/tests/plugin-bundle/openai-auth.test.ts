/**
 * OpenAI's per-server auth declaration (`extensions["com.openai"].auth`),
 * read into a typed descriptor under the openai-compatible profile only.
 */

import { describe, expect, it } from "vitest";
import {
  parsePluginBundle,
  renderPluginApiKeyHeader,
  type ParsedPluginBundle,
} from "../../src/plugin-bundle/index.js";
import { bitsAndBoltsRemoteFiles } from "./compat-fixtures.js";
import { bundle, manifestJson, mcpJson } from "./fixtures.js";

const compat = { profile: "openai-compatible" } as const;
const URL_OK = "https://mcp.example.com/mcp";

/** A root mcp.json with `api` declaring `auth`, plus an untouched sibling. */
function withAuth(auth: unknown, entry: Record<string, unknown> = {}) {
  return bundle({
    "plugin.json": manifestJson(),
    "mcp.json": mcpJson({
      api: {
        type: "streamable-http",
        url: URL_OK,
        extensions: { "com.openai": { auth } },
        ...entry,
      },
      sibling: {
        type: "streamable-http",
        url: "https://other.example.com/mcp",
      },
    }),
  });
}

const httpConfig = (parsed: ParsedPluginBundle, key = "api") => {
  const config = parsed.mcpServers.find((s) => s.key === key)?.config;
  if (config?.transport !== "http") throw new Error(`no http server ${key}`);
  return config;
};

describe("profiles", () => {
  it("keeps the strict closed entry: extensions invalidate the entry", async () => {
    const parsed = await parsePluginBundle(withAuth({ type: "oauth" }));
    expect(parsed.mcpServers.map((s) => s.key)).toEqual(["sibling"]);
    expect(parsed.warnings.map((w) => w.code)).toContain("MCP_UNKNOWN_FIELD");
  });

  it("reads the auth of a legacy http entry", async () => {
    const { ".app.json": _apps, ...files } = bitsAndBoltsRemoteFiles({
      type: "oauth",
      client: { mode: "dcr" },
    });
    const parsed = await parsePluginBundle(bundle(files), compat);
    expect(httpConfig(parsed, "bits-and-bolts")).toMatchObject({
      httpVariant: "streamable-http",
      auth: { type: "oauth", client: { mode: "dcr" } },
    });
    expect(parsed.setupRequirements).toEqual([
      expect.objectContaining({ kind: "oauth", required: true }),
    ]);
  });

  it("accepts and ignores extensions on a stdio entry", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        "plugin.json": manifestJson(),
        "mcp.json": mcpJson({
          local: {
            type: "stdio",
            command: "node",
            extensions: { "com.openai": { auth: { type: "oauth" } } },
          },
        }),
      }),
      compat
    );
    expect(parsed.mcpServers[0].config).not.toHaveProperty("auth");
    expect(parsed.setupRequirements).toEqual([]);
  });
});

describe("auth types", () => {
  it("reads oauth with every documented field, keeping endpoints exactly as declared", async () => {
    const auth = {
      type: "oauth",
      client: {
        mode: "provided",
        // A real client ID can be a long opaque run; it is public, so kept.
        clientId: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2.apps.example",
        tokenEndpointAuthMethod: "client_secret_post",
      },
      registrationUrl: "https://auth.example.com/register",
      authorizationUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      authorizationServerBase: "https://auth.example.com",
      resource: "https://mcp.example.com",
      baseScopes: ["openid"],
      defaultScopes: [],
      oidcEnabled: true,
      oidcConfigurationUrl:
        "https://auth.example.com/.well-known/openid-configuration",
      oidcUserinfoEndpoint: "https://auth.example.com/userinfo",
      oidcScopesSupported: ["openid", "email"],
    };
    const parsed = await parsePluginBundle(withAuth(auth), compat);
    expect(httpConfig(parsed).auth).toEqual(auth);
    expect(parsed.warnings).toEqual([]);
  });

  it("accepts a loopback HTTP endpoint and an @ inside a path", async () => {
    const auth = {
      type: "oauth",
      authorizationUrl: "https://auth.example.com/u/@me/authorize",
      tokenUrl: "http://127.0.0.1:8080/token",
    };
    const parsed = await parsePluginBundle(withAuth(auth), compat);
    expect(httpConfig(parsed).auth).toEqual(auth);
  });

  it("marks mixed sign-in optional and none as needing nothing", async () => {
    const mixed = await parsePluginBundle(withAuth({ type: "mixed" }), compat);
    expect(mixed.setupRequirements).toEqual([
      {
        kind: "oauth",
        componentKey: "server:api",
        serverKey: "api",
        required: false,
      },
    ]);
    const none = await parsePluginBundle(withAuth({ type: "none" }), compat);
    expect(httpConfig(none).auth).toEqual({ type: "none" });
    expect(none.setupRequirements).toEqual([]);
  });

  it("turns an API key into a secret header requirement with its scheme", async () => {
    const parsed = await parsePluginBundle(
      withAuth({ type: "api_key", headerScheme: "bearer" }),
      compat
    );
    expect(httpConfig(parsed).headerRequirements).toEqual([
      { name: "Authorization", secret: true, scheme: "bearer" },
    ]);
    expect(parsed.setupRequirements).toEqual([
      expect.objectContaining({
        kind: "header",
        name: "Authorization",
        secret: true,
        scheme: "bearer",
      }),
    ]);
  });

  it("merges a custom API key header with a declared header of any casing", async () => {
    const parsed = await parsePluginBundle(
      withAuth(
        {
          type: "api_key",
          headerScheme: "custom_header",
          headerName: "X-Api-Key",
        },
        { headers: { "x-api-key": "${KEY}", "X-Version": "2" } }
      ),
      compat
    );
    expect(httpConfig(parsed).headerRequirements).toEqual([
      { name: "X-Api-Key", secret: true, scheme: "custom_header" },
      { name: "X-Version", secret: false, value: "2" },
    ]);
  });

  it("keeps MCPJam's own oauth hint beside the declaration, as one requirement", async () => {
    const parsed = await parsePluginBundle(
      withAuth(
        { type: "oauth" },
        { authentication: "on_install", oauth: { scopes: ["read"] } }
      ),
      compat
    );
    expect(httpConfig(parsed).oauth).toEqual({
      timing: "on_install",
      scopes: ["read"],
    });
    expect(parsed.setupRequirements).toEqual([
      {
        kind: "oauth",
        componentKey: "server:api",
        serverKey: "api",
        timing: "on_install",
        required: true,
      },
    ]);
  });
});

describe("credentials and unknown fields", () => {
  it("never stores a credential, wherever it is declared", async () => {
    const parsed = await parsePluginBundle(
      withAuth({
        type: "oauth",
        clientSecret: "shh-top-level-secret",
        client: {
          mode: "provided",
          clientId: "public-client",
          clientSecret: "shh-nested-secret",
        },
      }),
      compat
    );
    expect(JSON.stringify(parsed.mcpServers)).not.toMatch(/shh-/);
    expect(JSON.stringify(parsed.warnings)).not.toMatch(/shh-/);
    expect(
      parsed.warnings.filter((w) => w.code === "MCP_SECRET_FIELD_OMITTED")
    ).toHaveLength(2);
    expect(httpConfig(parsed).auth).toEqual({
      type: "oauth",
      client: { mode: "provided", clientId: "public-client" },
    });
  });

  it("drops a client ID from a registered (dcr/cimd) client", async () => {
    for (const mode of ["dcr", "cimd"]) {
      const parsed = await parsePluginBundle(
        withAuth({ type: "oauth", client: { mode, clientId: "nope" } }),
        compat
      );
      expect(httpConfig(parsed).auth).toEqual({
        type: "oauth",
        client: { mode },
      });
    }
  });

  it("drops undocumented fields with a warning", async () => {
    const parsed = await parsePluginBundle(
      withAuth({ type: "none", note: "x" }),
      compat
    );
    expect(httpConfig(parsed).auth).toEqual({ type: "none" });
    expect(parsed.warnings).toEqual([
      expect.objectContaining({
        code: "MCP_UNKNOWN_FIELD",
        severity: "warning",
      }),
    ]);
  });
});

describe("invalid declarations skip only their entry", () => {
  it.each([
    ["a non-object auth", "oauth"],
    ["an unknown type", { type: "magic" }],
    ["a non-object client", { type: "oauth", client: "dcr" }],
    ["an unknown client mode", { type: "oauth", client: { mode: "psk" } }],
    [
      "a provided client without an ID",
      { type: "oauth", client: { mode: "provided" } },
    ],
    [
      "an unsupported token endpoint method",
      {
        type: "oauth",
        client: {
          mode: "provided",
          clientId: "c",
          tokenEndpointAuthMethod: "mtls",
        },
      },
    ],
    [
      "an endpoint with credentials",
      { type: "oauth", tokenUrl: "https://u:p4ss@a.example.com/t" },
    ],
    [
      "an endpoint with a fragment",
      { type: "oauth", tokenUrl: "https://a.example.com/t#x" },
    ],
    [
      "an endpoint with empty userinfo",
      { type: "oauth", tokenUrl: "https://@a.example.com/t" },
    ],
    [
      "an endpoint with empty userinfo after extra slashes",
      { type: "oauth", tokenUrl: "https:///@a.example.com/t" },
    ],
    [
      "an endpoint with empty userinfo and no slashes",
      { type: "oauth", tokenUrl: "https:@a.example.com/t" },
    ],
    [
      "an endpoint with an empty fragment",
      { type: "oauth", tokenUrl: "https://a.example.com/t#" },
    ],
    // `URL` reads these differently from the string that would be stored.
    [
      "an endpoint whose backslash hides user info",
      { type: "oauth", tokenUrl: "https://a.example.com\\@evil.example/t" },
    ],
    [
      "an endpoint with a space",
      { type: "oauth", tokenUrl: "https://a.example.com/t x" },
    ],
    [
      "an endpoint with a tab inside the host",
      { type: "oauth", tokenUrl: "https://a.exa\tmple.com/t" },
    ],
    [
      "an endpoint with a trailing newline",
      { type: "oauth", resource: "https://a.example.com/mcp\n" },
    ],
    [
      "an endpoint with a control character",
      { type: "oauth", tokenUrl: "https://a.example.com/t\u0001" },
    ],
    [
      "a plain-HTTP remote endpoint",
      { type: "oauth", tokenUrl: "http://a.example.com/t" },
    ],
    ["a relative endpoint", { type: "oauth", resource: "/mcp" }],
    ["non-string scopes", { type: "oauth", baseScopes: ["a", 1] }],
    ["a non-boolean oidcEnabled", { type: "oauth", oidcEnabled: "yes" }],
    ["an API key without a scheme", { type: "api_key" }],
    [
      "a custom header without a name",
      { type: "api_key", headerScheme: "custom_header" },
    ],
    [
      "a custom Host header",
      { type: "api_key", headerScheme: "custom_header", headerName: "host" },
    ],
    [
      "an invalid header name",
      { type: "api_key", headerScheme: "custom_header", headerName: "X Key" },
    ],
  ])("%s", async (_label, auth) => {
    const parsed = await parsePluginBundle(withAuth(auth), compat);
    expect(parsed.mcpServers.map((s) => s.key)).toEqual(["sibling"]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "server", key: "api" }),
    ]);
    // An endpoint with userinfo is a credential: it is never echoed.
    expect(JSON.stringify(parsed)).not.toContain("p4ss");
  });
});

describe("renderPluginApiKeyHeader", () => {
  const bearer = { type: "api_key", headerScheme: "bearer" } as const;
  const basic = { type: "api_key", headerScheme: "basic" } as const;

  it.each([
    ["abc", "Bearer abc"],
    ["Bearer abc", "Bearer abc"],
    ["bearer  abc ", "Bearer abc"],
  ])("sends bearer credential %j as %j, prefixed once", (credential, value) => {
    expect(renderPluginApiKeyHeader(bearer, credential)).toEqual({
      name: "Authorization",
      value,
    });
  });

  it("prefixes an encoded Basic token once", () => {
    expect(renderPluginApiKeyHeader(basic, "dXNlcjpwYXNz").value).toBe(
      "Basic dXNlcjpwYXNz"
    );
    expect(renderPluginApiKeyHeader(basic, "Basic dXNlcjpwYXNz").value).toBe(
      "Basic dXNlcjpwYXNz"
    );
  });

  it("sends a custom header verbatim", () => {
    expect(
      renderPluginApiKeyHeader(
        { type: "api_key", headerScheme: "custom_header", headerName: "X-Key" },
        " Bearer k "
      )
    ).toEqual({ name: "X-Key", value: "Bearer k" });
  });
});
