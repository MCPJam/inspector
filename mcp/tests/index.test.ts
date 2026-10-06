/**
 * The worker entrypoint over the real wire: who `/mcp` serves, and what a
 * client is told when it is not served.
 *
 * The regression this file exists for: with no token, `initialize` and
 * `tools/list` answered 200, so a client never saw a 401 and never ran OAuth —
 * and then every tool call failed with "No bearer token on the request.",
 * because the worker could not mint the guest it had implicitly promised.
 *
 * Tokens are real RS256 JWTs. Their keys are served from a stubbed global
 * `fetch`, which is what jose's remote JWKS calls, so verification runs the
 * production key-resolution path rather than an injected key.
 */
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { GUEST_ISSUER } from "../src/auth.js";
import { EXCLUDED_FROM_CATALOG } from "../src/tools/platformTools.js";

const ORIGIN = "https://mcp.test";
const CLIENT_ID = "client_test_0123456789";
const AUTHKIT_DOMAIN = "login.example.test";
const AUTHKIT_ISSUER = `https://${AUTHKIT_DOMAIN}`;
const AUTHKIT_JWKS_URL = `${AUTHKIT_ISSUER}/oauth2/jwks`;
const GUEST_JWKS_URL = "https://app.example.test/api/web/guest-jwks";
const GUEST_MINT_URL = "https://app.example.test/api/web/guest-token";
const RESOURCE_METADATA_URL = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;

/**
 * The tools held off this surface while their feature is in beta. Spelled out
 * rather than read from `HELD_WHILE_IN_BETA`, so a tool silently released
 * from the hold fails here instead of passing by construction.
 */
const HELD_TOOLS = [
  "start_claude_readiness_run",
  "start_openai_readiness_run",
  "get_readiness_run",
  "list_readiness_runs",
  "cancel_readiness_run",
  "get_readiness_report",
  "start_conformance_run",
  "get_conformance_run",
  "list_conformance_runs",
  "get_conformance_report",
  "search_sessions",
  "search_registry_directory",
  "get_registry_directory_server",
  "list_registry_directory_sources",
  "install_registry_directory_server",
  "drive_chat_session_browser",
  "observe_chat_session_browser",
  "list_project_skills",
  "get_project_skill",
  "list_sandbox_images",
  "get_sandbox_image",
  "list_project_plugins",
  "get_plugin_version",
  "list_eval_github_repos",
  "connect_eval_github_repo",
  "list_eval_check_repos",
  "connect_eval_check_repo",
  "propose_eval_description_rewrite",
  "start_eval_description_experiment",
  "get_eval_description_experiment",
  "set_eval_suite_schedule",
];

type GuestAccessSetting = "off" | "mixed" | undefined;

function makeEnv(
  options: { guestAccess?: GuestAccessSetting; serviceToken?: boolean } = {}
): Env {
  return {
    AUTHKIT_DOMAIN,
    WORKOS_CLIENT_ID: CLIENT_ID,
    PLATFORM_API_URL: "https://app.example.test/api/v1",
    MCPJAM_APP_ORIGIN: "https://app.example.test",
    MCPJAM_GUEST_JWKS_URL: GUEST_JWKS_URL,
    MCPJAM_GUEST_MINT_URL: GUEST_MINT_URL,
    ...(options.guestAccess
      ? { MCPJAM_GUEST_ACCESS: options.guestAccess }
      : {}),
    ...(options.serviceToken
      ? { MCPJAM_INSPECTOR_SERVICE_TOKEN: "service-token" }
      : {}),
  } as unknown as Env;
}

let authkitKey: CryptoKey;
let guestKey: CryptoKey;
let authkitJwks: { keys: unknown[] };
let guestJwks: { keys: unknown[] };

beforeAll(async () => {
  // One key pair per issuer for the whole file: jose caches a remote JWKS per
  // URL, so rotating keys between tests would test that cache instead.
  const authkit = await generateKeyPair("RS256", { extractable: true });
  const guest = await generateKeyPair("RS256", { extractable: true });
  authkitKey = authkit.privateKey;
  guestKey = guest.privateKey;
  authkitJwks = {
    keys: [
      { ...(await exportJWK(authkit.publicKey)), kid: "authkit", alg: "RS256" },
    ],
  };
  guestJwks = {
    keys: [
      { ...(await exportJWK(guest.publicKey)), kid: "guest", alg: "RS256" },
    ],
  };
});

/** Every outbound fetch the worker makes, by URL. */
let fetched: string[] = [];

function stubOutboundFetch(extra: Record<string, unknown> = {}) {
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: unknown) => {
      const url = target instanceof Request ? target.url : String(target);
      fetched.push(url);
      if (url === AUTHKIT_JWKS_URL) return Response.json(authkitJwks);
      if (url === GUEST_JWKS_URL) return Response.json(guestJwks);
      if (url in extra) return Response.json(extra[url]);
      throw new Error(`Unexpected fetch: ${url}`);
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function authkitToken(): Promise<string> {
  // Audienced to this server's resource identifier — what AuthKit mints for a
  // third-party MCP client such as Claude Code.
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "authkit" })
    .setIssuer(AUTHKIT_ISSUER)
    .setAudience(`${ORIGIN}/mcp`)
    .setSubject("user_123")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(authkitKey);
}

async function guestToken(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "guest" })
    .setIssuer(GUEST_ISSUER)
    .setSubject("guest_123")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(guestKey);
}

const INITIALIZE_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "0" },
};

function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  bearer?: string
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/** Legacy-era responses are SSE (`event: message\ndata: {…}`); unwrap them. */
async function jsonRpcResult(response: Response): Promise<any> {
  const text = await response.text();
  const json = text.startsWith("event:")
    ? JSON.parse(text.slice(text.indexOf("data: ") + 6).split("\n")[0]!)
    : JSON.parse(text);
  return json.result;
}

function expectOAuthChallenge(response: Response, error?: "invalid_token") {
  expect(response.status).toBe(401);
  const challenge = response.headers.get("www-authenticate") ?? "";
  expect(challenge).toMatch(/^Bearer /);
  expect(challenge).toContain(`resource_metadata="${RESOURCE_METADATA_URL}"`);
  if (error) {
    expect(challenge).toContain(`error="${error}"`);
  } else {
    // RFC 6750 §3.1: no error code when credentials are simply absent.
    expect(challenge).not.toContain("error=");
  }
  // A browser client can only read the challenge if it is exposed.
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("access-control-expose-headers")).toContain(
    "WWW-Authenticate"
  );
}

describe("/mcp when signed-in only", () => {
  for (const guestAccess of ["off", undefined] as const) {
    const label = guestAccess ?? "unset";

    it(`answers a tokenless initialize and tools/list with the OAuth 401 (${label})`, async () => {
      stubOutboundFetch();
      const env = makeEnv({ guestAccess, serviceToken: true });

      for (const request of [
        mcpRequest("initialize", INITIALIZE_PARAMS),
        mcpRequest("tools/list"),
      ]) {
        expectOAuthChallenge(await worker.fetch(request, env));
      }
      // Refused before anything else happens: no guest is minted.
      expect(fetched).toEqual([]);
    });

    it(`rejects a guest token (${label})`, async () => {
      stubOutboundFetch();
      const response = await worker.fetch(
        mcpRequest("tools/list", {}, await guestToken()),
        makeEnv({ guestAccess, serviceToken: true })
      );
      expectOAuthChallenge(response, "invalid_token");
      // The guest issuer is not on the allow-list, so its JWKS is never read.
      expect(fetched).not.toContain(GUEST_JWKS_URL);
    });
  }

  it("treats an unrecognised value as off", async () => {
    stubOutboundFetch();
    const response = await worker.fetch(
      mcpRequest("initialize", INITIALIZE_PARAMS),
      makeEnv({ guestAccess: "on" as GuestAccessSetting, serviceToken: true })
    );
    expectOAuthChallenge(response);
  });

  it("rejects a malformed bearer", async () => {
    stubOutboundFetch();
    const response = await worker.fetch(
      mcpRequest("initialize", INITIALIZE_PARAMS, "not-a-jwt"),
      makeEnv({ guestAccess: "off" })
    );
    expectOAuthChallenge(response, "invalid_token");
  });

  it("serves a valid AuthKit token", async () => {
    stubOutboundFetch();
    const env = makeEnv({ guestAccess: "off" });
    const token = await authkitToken();

    const initialize = await worker.fetch(
      mcpRequest("initialize", INITIALIZE_PARAMS, token),
      env
    );
    expect(initialize.status).toBe(200);
    expect((await jsonRpcResult(initialize)).serverInfo.name).toBe(
      "MCPJam MCP"
    );

    const list = await worker.fetch(mcpRequest("tools/list", {}, token), env);
    expect(list.status).toBe(200);
    const names = (await jsonRpcResult(list)).tools.map(
      (tool: { name: string }) => tool.name
    );
    expect(names).toContain("get_me");
    expect(names).toContain("show_servers");
  });
});

describe("/mcp with guests (mixed)", () => {
  it("serves a tokenless request when the worker can mint, without minting at list time", async () => {
    stubOutboundFetch();
    const env = makeEnv({ guestAccess: "mixed", serviceToken: true });

    const initialize = await worker.fetch(
      mcpRequest("initialize", INITIALIZE_PARAMS),
      env
    );
    expect(initialize.status).toBe(200);
    const list = await worker.fetch(mcpRequest("tools/list"), env);
    expect(list.status).toBe(200);
    expect((await jsonRpcResult(list)).tools.length).toBeGreaterThan(0);
    // The guest is minted on first tool execution, never to list tools.
    expect(fetched).not.toContain(GUEST_MINT_URL);
  });

  it("serves a valid guest token", async () => {
    stubOutboundFetch();
    const response = await worker.fetch(
      mcpRequest("tools/list", {}, await guestToken()),
      makeEnv({ guestAccess: "mixed", serviceToken: true })
    );
    expect(response.status).toBe(200);
  });

  it("still serves a valid AuthKit token", async () => {
    stubOutboundFetch();
    const response = await worker.fetch(
      mcpRequest("tools/list", {}, await authkitToken()),
      makeEnv({ guestAccess: "mixed", serviceToken: true })
    );
    expect(response.status).toBe(200);
  });

  it("never downgrades a bad bearer to an anonymous guest", async () => {
    stubOutboundFetch();
    const response = await worker.fetch(
      mcpRequest("tools/list", {}, "not-a-jwt"),
      makeEnv({ guestAccess: "mixed", serviceToken: true })
    );
    expectOAuthChallenge(response, "invalid_token");
  });

  describe("without the mint secret", () => {
    // The re-import below re-evaluates the worker's whole module graph, the
    // platform operation catalog included, inside the test body. That is quick
    // alone but passed the 5s default on a CI runner busy with every other
    // workspace's suite, hence the longer timeout.
    it("answers a tokenless request with the OAuth 401 and logs the misconfiguration once", async () => {
      stubOutboundFetch();
      // A fresh module instance: the warning is once per isolate, and earlier
      // tests in this file share the cached one.
      vi.resetModules();
      const { default: freshWorker } = await import("../src/index.js");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const env = makeEnv({ guestAccess: "mixed" });

      for (const request of [
        mcpRequest("initialize", INITIALIZE_PARAMS),
        mcpRequest("tools/list"),
      ]) {
        expectOAuthChallenge(await freshWorker.fetch(request, env));
      }
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain(
        "MCPJAM_INSPECTOR_SERVICE_TOKEN"
      );
    }, 30_000);

    it("still verifies a presented guest token", async () => {
      stubOutboundFetch();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const env = makeEnv({ guestAccess: "mixed" });

      const valid = await worker.fetch(
        mcpRequest("tools/list", {}, await guestToken()),
        env
      );
      expect(valid.status).toBe(200);

      const forged = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "guest" })
        .setIssuer(GUEST_ISSUER)
        .setSubject("guest_123")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(authkitKey);
      const rejected = await worker.fetch(
        mcpRequest("tools/list", {}, forged),
        env
      );
      expectOAuthChallenge(rejected, "invalid_token");
    });
  });
});

describe("held beta tools", () => {
  it("are missing from tools/list", async () => {
    stubOutboundFetch();
    const response = await worker.fetch(
      mcpRequest("tools/list", {}, await authkitToken()),
      makeEnv({ guestAccess: "off" })
    );
    const names: string[] = (await jsonRpcResult(response)).tools.map(
      (tool: { name: string }) => tool.name
    );
    expect(names.filter((name) => HELD_TOOLS.includes(name))).toEqual([]);
  });

  it("are excluded from the catalog with a held-in-beta reason", () => {
    for (const name of HELD_TOOLS) {
      expect(EXCLUDED_FROM_CATALOG[name], name).toMatch(
        /^Held while .+ is in beta\./
      );
    }
    const held = Object.entries(EXCLUDED_FROM_CATALOG)
      .filter(([, reason]) => reason.startsWith("Held while "))
      .map(([name]) => name)
      .sort();
    expect(held).toEqual([...HELD_TOOLS].sort());
  });
});

describe("routes that need no token", () => {
  it("answers the /mcp CORS preflight", async () => {
    stubOutboundFetch();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, { method: "OPTIONS" }),
      makeEnv({ guestAccess: "off" })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "authorization"
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "mcp-method"
    );
  });

  it("serves protected-resource metadata on both paths", async () => {
    stubOutboundFetch();
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const response = await worker.fetch(
        new Request(`${ORIGIN}${path}`),
        makeEnv({ guestAccess: "off" })
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toEqual({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [AUTHKIT_ISSUER],
        bearer_methods_supported: ["header"],
      });
    }
  });

  it("answers the discovery preflight", async () => {
    stubOutboundFetch();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`, {
        method: "OPTIONS",
      }),
      makeEnv({ guestAccess: "off" })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET, OPTIONS"
    );
  });

  it("proxies authorization-server metadata from the AuthKit issuer", async () => {
    const metadata = { issuer: AUTHKIT_ISSUER };
    stubOutboundFetch({
      [`${AUTHKIT_ISSUER}/.well-known/oauth-authorization-server`]: metadata,
    });
    const response = await worker.fetch(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
      makeEnv({ guestAccess: "off" })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual(metadata);
  });
});
