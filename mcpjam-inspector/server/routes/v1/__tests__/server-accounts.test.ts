import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// The v1 server accounts API and the deprecated import-tokens alias, against a
// mocked Convex that answers the way the backend contract says it will.

const {
  validateGuestTokenMock,
  validateApiKeyMock,
  resolveUserByExternalIdMock,
  lookupWorkosKeyBindingMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  validateApiKeyMock: vi.fn(),
  resolveUserByExternalIdMock: vi.fn(),
  lookupWorkosKeyBindingMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));
vi.mock("../../../services/workos-client.js", () => ({
  getWorkOSClient: () => ({
    apiKeys: { createValidation: validateApiKeyMock },
  }),
}));
vi.mock("../../../services/identity.js", () => ({
  resolveUserByExternalId: resolveUserByExternalIdMock,
}));
vi.mock("../../../services/workos-key-bindings.js", () => ({
  lookupWorkosKeyBinding: lookupWorkosKeyBindingMock,
}));

import v1Routes from "../index.js";
import { accountViewSchema } from "../server-account-backend.js";

const CONVEX = "https://convex-http.example.com";
const PROJECT = "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx";
const BASE = `/api/v1/projects/${PROJECT}/servers/srv1/accounts`;
const ACCOUNT = {
  id: "acct_1",
  name: "test-automation-1",
  kind: "personal",
  isDefault: false,
  needsReconnect: false,
  hostedOnly: true,
  expiresAt: 3_600_000,
  createdAt: 10,
  updatedAt: 20,
};
/** What a backend row could carry beyond the view, none of it publishable. */
const BACKEND_EXTRAS = {
  accessToken: "at_leak",
  refreshToken: "rt_leak",
  vaultObjectId: "vault_1",
  email: "someone@example.com",
  profile: { id: "u1", email: "someone@example.com" },
};
const UPLOAD = {
  tokens: { access_token: "at_example", expires_in: 3600 },
  clientInformation: { clientId: "client_example" },
};

type Answer = { status?: number; body: unknown };

/** Answer Convex by path, recording every call. */
function stubConvex(answers: Record<string, Answer | Answer[]>) {
  const calls: Array<{ path: string; body: unknown; headers: Headers }> = [];
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input).replace(CONVEX, "");
    calls.push({
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    });
    const entry = answers[path];
    const answer = Array.isArray(entry) ? entry.shift() : entry;
    if (!answer) throw new Error(`unexpected Convex call ${path}`);
    return Response.json(answer.body, { status: answer.status ?? 200 });
  }) as typeof fetch;
  return calls;
}

function send(
  method: string,
  path: string,
  body?: unknown,
  token = "tok",
): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

describe("v1 server accounts", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CONVEX_HTTP_URL", CONVEX);
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("lists accounts and publishes only the account view", async () => {
    const calls = stubConvex({
      "/web/oauth/connections": {
        body: { shared: false, accounts: [{ ...ACCOUNT, ...BACKEND_EXTRAS }] },
      },
    });
    const res = await send("GET", BASE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [ACCOUNT] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      projectId: PROJECT,
      serverId: "srv1",
      view: "api",
    });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok");
  });

  it("reads one account by reference", async () => {
    const calls = stubConvex({
      "/web/oauth/connections/get": {
        body: { account: { ...ACCOUNT, ...BACKEND_EXTRAS } },
      },
    });
    const res = await send("GET", `${BASE}/test-automation-1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ACCOUNT);
    expect(calls[0]!.body).toEqual({
      projectId: PROJECT,
      serverId: "srv1",
      account: { ref: "test-automation-1" },
      view: "api",
    });
  });

  it.each([
    [true, 201],
    [false, 200],
  ])(
    "uploads with created=%s as %i, without connecting to the server",
    async (created, status) => {
      const calls = stubConvex({
        "/web/oauth/import-tokens": {
          body: {
            success: true,
            created,
            account: { ...ACCOUNT, ...BACKEND_EXTRAS },
            expiresAt: ACCOUNT.expiresAt,
          },
        },
      });
      const res = await send("PUT", `${BASE}/test-automation-1`, UPLOAD);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(ACCOUNT);
      // One call: the upload. Nothing authorizes or dials the MCP server.
      expect(calls.map((call) => call.path)).toEqual([
        "/web/oauth/import-tokens",
      ]);
      expect(calls[0]!.body).toEqual({
        projectId: PROJECT,
        serverId: "srv1",
        kind: "generic",
        account: { ref: "test-automation-1" },
        hostedOnly: "always",
        source: "api",
        ...UPLOAD,
      });
    },
  );

  it.each([
    [
      "an ID token",
      { ...UPLOAD, tokens: { access_token: "at", id_token: "it" } },
      "field_not_accepted",
      "tokens.id_token",
    ],
    [
      "a server URL",
      { ...UPLOAD, serverUrl: "https://elsewhere.example.com/mcp" },
      "field_not_accepted",
      "serverUrl",
    ],
    [
      "an authorization server URL",
      { ...UPLOAD, authorizationServerUrl: "https://as.example.com" },
      "field_not_accepted",
      "authorizationServerUrl",
    ],
    [
      "an unknown field",
      { ...UPLOAD, clientInformation: { clientId: "c", tenant: "t" } },
      undefined,
      "clientInformation.tenant",
    ],
    [
      "an access token over 16 KB",
      { ...UPLOAD, tokens: { access_token: "a".repeat(16 * 1024 + 1) } },
      "token_too_large",
      "tokens.access_token",
    ],
    [
      "a refresh token over 16 KB in bytes, not characters",
      {
        ...UPLOAD,
        tokens: { access_token: "a", refresh_token: "é".repeat(8193) },
      },
      "token_too_large",
      "tokens.refresh_token",
    ],
    [
      "no client information",
      { tokens: UPLOAD.tokens },
      undefined,
      "clientInformation",
    ],
  ])(
    "refuses %s before anything is stored",
    async (_label, body, code, field) => {
      const calls = stubConvex({});
      const res = await send("PUT", `${BASE}/test-automation-1`, body);
      expect(res.status).toBe(400);
      const error = (await res.json()) as {
        code: string;
        message: string;
        details?: { code?: string };
      };
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.details?.code).toBe(code);
      expect(error.message).toContain(field);
      expect(calls).toEqual([]);
    },
  );

  it("accepts a 16 KB token exactly", async () => {
    stubConvex({
      "/web/oauth/import-tokens": {
        body: { success: true, created: false, account: ACCOUNT, expiresAt: 1 },
      },
    });
    const res = await send("PUT", `${BASE}/a`, {
      ...UPLOAD,
      tokens: { access_token: "a".repeat(16 * 1024) },
    });
    expect(res.status).toBe(200);
  });

  it("renames with the API name rule, then sets the default by id", async () => {
    const renamed = { ...ACCOUNT, name: "ci-primary" };
    const calls = stubConvex({
      "/web/oauth/connections/label": { body: { account: renamed } },
      "/web/oauth/connections/default": {
        body: { account: { ...renamed, isDefault: true } },
      },
    });
    const res = await send("PATCH", `${BASE}/test-automation-1`, {
      name: "ci-primary",
      isDefault: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...renamed, isDefault: true });
    expect(calls.map((call) => call.body)).toEqual([
      {
        projectId: PROJECT,
        serverId: "srv1",
        account: { ref: "test-automation-1" },
        label: "ci-primary",
        nameRules: "api",
        view: "api",
      },
      // The old name no longer matches, so the second call goes by id.
      {
        projectId: PROJECT,
        serverId: "srv1",
        account: { ref: "acct_1" },
        view: "api",
      },
    ]);
  });

  it("sets the default alone by the caller's reference", async () => {
    const calls = stubConvex({
      "/web/oauth/connections/default": {
        body: { account: { ...ACCOUNT, isDefault: true } },
      },
    });
    const res = await send("PATCH", `${BASE}/test-automation-1`, {
      isDefault: true,
    });
    expect(res.status).toBe(200);
    expect(calls.map((call) => call.path)).toEqual([
      "/web/oauth/connections/default",
    ]);
    expect(calls[0]!.body).toMatchObject({
      account: { ref: "test-automation-1" },
    });
  });

  it.each([
    [{ isDefault: false }, "another account"],
    [{ name: "ci", isDefault: false }, "another account"],
    [{}, "isDefault"],
    [{ name: "ci", label: "ci" }, "label"],
  ])("refuses the update %j before any write", async (body, phrase) => {
    const calls = stubConvex({});
    const res = await send("PATCH", `${BASE}/acct_1`, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      phrase,
    );
    expect(calls).toEqual([]);
  });

  it("deletes with refuseIfDefault and answers with a receipt", async () => {
    const calls = stubConvex({
      "/web/oauth/connections/delete": { body: { outcome: "deleted" } },
    });
    const res = await send("DELETE", `${BASE}/test-automation-1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      account: "test-automation-1",
      deleted: true,
    });
    expect(calls[0]!.body).toEqual({
      projectId: PROJECT,
      serverId: "srv1",
      account: { ref: "test-automation-1" },
      refuseIfDefault: true,
    });
  });

  it("refuses a delete with a body, so refuseIfDefault cannot be turned off", async () => {
    const calls = stubConvex({});
    const res = await send("DELETE", `${BASE}/acct_1`, {
      refuseIfDefault: false,
    });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it.each([
    [400, "invalid_account_name", "VALIDATION_ERROR", {}],
    [400, "server_url_mismatch", "VALIDATION_ERROR", {}],
    [400, "token_too_large", "VALIDATION_ERROR", {}],
    [400, "field_not_accepted", "VALIDATION_ERROR", {}],
    [403, "admin_required", "FORBIDDEN", {}],
    [404, "account_not_found", "NOT_FOUND", {}],
    [409, "account_name_ambiguous", "CONFLICT", { accountIds: ["a1", "a2"] }],
    [409, "account_name_taken", "CONFLICT", {}],
    [409, "account_is_default", "CONFLICT", {}],
    [409, "account_limit_reached", "CONFLICT", {}],
    [429, "rate_limited", "RATE_LIMITED", { retryAfterMs: 1_500 }],
  ])(
    "answers the backend's %i %s with the same status and its copy",
    async (status, backendCode, v1Code, extra) => {
      stubConvex({
        "/web/oauth/import-tokens": {
          status,
          body: {
            success: false,
            code: backendCode,
            error: `Backend sentence for ${backendCode}.`,
            ...extra,
            internalOnly: "never published",
          },
        },
      });
      const res = await send("PUT", `${BASE}/test-automation-1`, UPLOAD);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({
        code: v1Code,
        message: `Backend sentence for ${backendCode}.`,
        details: { code: backendCode, ...extra },
      });
      expect(res.headers.get("retry-after")).toBe(status === 429 ? "2" : null);
    },
  );

  it("carries the account id an identity conflict names", async () => {
    stubConvex({
      "/web/oauth/connections/get": {
        status: 409,
        body: {
          success: false,
          code: "account_name_ambiguous",
          error: "Two accounts are named test-automation-1.",
          accountIds: ["a1", "a2"],
          accountId: "a1",
        },
      },
    });
    const res = await send("GET", `${BASE}/test-automation-1`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { details: unknown }).details).toEqual({
      code: "account_name_ambiguous",
      accountIds: ["a1", "a2"],
      accountId: "a1",
    });
  });

  it.each([
    ["a backend failure", { status: 500, body: { error: "Server Error" } }],
    ["an answer outside the contract", { body: { accounts: [{ id: 1 }] } }],
  ])("answers %s with an internal error", async (_label, answer) => {
    stubConvex({ "/web/oauth/connections": answer });
    const res = await send("GET", BASE);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe(
      "INTERNAL_ERROR",
    );
  });

  it("answers an unreachable backend with 502", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const res = await send("GET", BASE);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe(
      "SERVER_UNREACHABLE",
    );
  });

  it.each([
    ["GET", BASE],
    ["GET", `${BASE}/a`],
    ["PUT", `${BASE}/a`],
    ["PATCH", `${BASE}/a`],
    ["DELETE", `${BASE}/a`],
  ])("refuses guests on %s %s", async (method, path) => {
    validateGuestTokenMock.mockResolvedValue({
      valid: true,
      guestId: "guest_1",
    });
    const calls = stubConvex({});
    const res = await send(method, path, method === "PUT" ? UPLOAD : undefined);
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("acts as the API key's owner, never forwarding the key", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc_token");
    validateApiKeyMock.mockResolvedValue({
      apiKey: { id: "key_1", owner: { id: "workos_user_1" } },
    });
    resolveUserByExternalIdMock.mockResolvedValue({ _id: "convex_user_1" });
    lookupWorkosKeyBindingMock.mockResolvedValue({
      mcpjamOrganizationId: "org_1",
    });
    const calls = stubConvex({
      "/web/oauth/connections": { body: { shared: false, accounts: [] } },
    });
    const res = await send("GET", BASE, undefined, "sk_live_secret");
    expect(res.status).toBe(200);
    const headers = calls[0]!.headers;
    expect(headers.get("authorization")).toBe("Bearer svc_token");
    expect(headers.get("x-mcpjam-acting-as")).toBe("workos_user_1");
    expect(headers.get("x-mcpjam-acting-in-org")).toBe("org_1");
    expect(JSON.stringify(calls)).not.toContain("sk_live_secret");
  });
});

describe("deprecated oauth/import-tokens", () => {
  const originalFetch = global.fetch;
  const ALIAS = `/api/v1/projects/${PROJECT}/servers/srv1/oauth/import-tokens`;
  const LEGACY_BODY = {
    serverUrl: "https://mcp.example.com/mcp",
    oauthResourceUrl: "https://mcp.example.com",
    authorizationServerUrl: "https://as.example.com",
    clientInformation: { clientId: "client_example" },
    tokens: { access_token: "at", refresh_token: "rt", id_token: "it" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CONVEX_HTTP_URL", CONVEX);
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  function expectDeprecated(res: Response) {
    expect(res.headers.get("deprecation")).toBe("true");
    expect(res.headers.get("sunset")).toBe("Tue, 09 Feb 2027 00:00:00 GMT");
    expect(res.headers.get("link")).toBe(
      '</api/v1/projects/{projectId}/servers/{serverId}/accounts>; rel="successor-version"',
    );
  }

  it("uploads to the default account through the accounts upload", async () => {
    const calls = stubConvex({
      "/web/oauth/import-tokens": {
        body: {
          success: true,
          created: false,
          account: ACCOUNT,
          expiresAt: 123,
        },
      },
    });
    const res = await send("POST", ALIAS, LEGACY_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: true, expiresAt: 123 });
    expectDeprecated(res);
    expect(calls.map((call) => call.path)).toEqual([
      "/web/oauth/import-tokens",
    ]);
    // The caller's URLs other than serverUrl, and the ID token, are dropped.
    expect(calls[0]!.body).toEqual({
      projectId: PROJECT,
      serverId: "srv1",
      kind: "generic",
      account: { default: true },
      hostedOnly: "whenCreated",
      source: "api",
      serverUrl: "https://mcp.example.com/mcp",
      clientInformation: { clientId: "client_example" },
      tokens: { access_token: "at", refresh_token: "rt" },
    });
  });

  it("passes the backend's refusal of a different server URL through", async () => {
    stubConvex({
      "/web/oauth/import-tokens": {
        status: 400,
        body: {
          success: false,
          code: "server_url_mismatch",
          error: "serverUrl must be the server's saved URL.",
        },
      },
    });
    const res = await send("POST", ALIAS, LEGACY_BODY);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { details: unknown }).details).toEqual({
      code: "server_url_mismatch",
    });
    expectDeprecated(res);
  });

  it.each([
    ["no tokens", { serverUrl: "https://mcp.example.com/mcp" }],
    [
      "an oversized token",
      {
        ...LEGACY_BODY,
        tokens: { access_token: "a".repeat(16 * 1024 + 1) },
      },
    ],
    [
      "no client information",
      { serverUrl: LEGACY_BODY.serverUrl, tokens: { access_token: "at" } },
    ],
  ])("refuses %s with the accounts upload's checks", async (_label, body) => {
    const calls = stubConvex({});
    const res = await send("POST", ALIAS, body);
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("the accounts surface returns no token", () => {
  const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
  const FIELDS = [
    "id",
    "name",
    "kind",
    "isDefault",
    "needsReconnect",
    "hostedOnly",
    "expiresAt",
    "createdAt",
    "updatedAt",
  ];
  const FORBIDDEN = /token|secret|vault|email|profile|password/i;

  it("projects exactly the contract's account view", () => {
    expect(Object.keys(accountViewSchema.shape).sort()).toEqual(
      [...FIELDS].sort(),
    );
  });

  it("documents no token-like field in any account response", () => {
    const spec = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "docs", "reference", "openapi.json"),
        "utf8",
      ),
    ) as {
      paths: Record<string, Record<string, { responses?: unknown }>>;
      components: { schemas: Record<string, unknown> };
    };
    const reached = new Set<string>();
    const visit = (node: unknown, seen: Set<string>) => {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (typeof record.$ref === "string") {
        const name = record.$ref.split("/").pop()!;
        if (seen.has(name)) return;
        seen.add(name);
        visit(spec.components.schemas[name], seen);
        return;
      }
      for (const [key, child] of Object.entries(
        (record.properties as Record<string, unknown>) ?? {},
      )) {
        reached.add(key);
        visit(child, seen);
      }
      if (record.items) visit(record.items, seen);
    };
    const routes = Object.entries(spec.paths).filter(([path]) =>
      path.includes("/accounts"),
    );
    expect(routes.map(([path]) => path).sort()).toEqual([
      "/projects/{projectId}/servers/{serverId}/accounts",
      "/projects/{projectId}/servers/{serverId}/accounts/{account}",
    ]);
    for (const [, item] of routes) {
      for (const operation of Object.values(item)) {
        for (const response of Object.values(
          (operation.responses as Record<string, unknown>) ?? {},
        )) {
          const content = (response as { content?: Record<string, unknown> })
            .content?.["application/json"] as { schema?: unknown } | undefined;
          visit(content?.schema, new Set());
        }
      }
    }
    expect([...reached].filter((key) => FORBIDDEN.test(key))).toEqual([]);
    for (const field of FIELDS) expect(reached).toContain(field);
  });

  it("keeps a token out of the SDK's account type", () => {
    const source = readFileSync(
      join(REPO_ROOT, "sdk", "src", "platform", "server-account-types.ts"),
      "utf8",
    );
    const start = source.indexOf("export type PlatformServerAccount = {");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n};", start));
    const keys = [...body.matchAll(/^\s+(\w+)\??:/gm)].map((match) => match[1]);
    expect(keys.sort()).toEqual([...FIELDS].sort());
  });

  it("is absent from the guest allowlist", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "guest-allowed-paths.ts"),
      "utf8",
    );
    expect(source).not.toContain("accounts");
  });
});
