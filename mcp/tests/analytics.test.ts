/**
 * Usage events for what never reaches `/api/v1`: an agent identifying itself,
 * a skill read, and a request the worker refuses. Driven through the real
 * `worker.fetch` with real RS256 tokens, plus the body reader on its own.
 */
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import {
  createWorkerAnalytics,
  readMcpRequestFacts,
  recordMcpRequest,
} from "../src/analytics.js";
import { GUEST_ISSUER } from "../src/auth.js";
import { SKILLS_BUNDLE_ENTRIES } from "../src/generated/SkillsBundle.generated.js";

const ORIGIN = "https://mcp.test";
const AUTHKIT_DOMAIN = "login.example.test";
const AUTHKIT_ISSUER = `https://${AUTHKIT_DOMAIN}`;
const AUTHKIT_JWKS_URL = `${AUTHKIT_ISSUER}/oauth2/jwks`;
const CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";
const KEY = "phc_test_key";

let authkitKey: CryptoKey;
let authkitJwks: { keys: unknown[] };

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  authkitKey = pair.privateKey;
  authkitJwks = {
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "authkit", alg: "RS256" }],
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeEnv(withKey = true): Env {
  return {
    AUTHKIT_DOMAIN,
    WORKOS_CLIENT_ID: "client_test_0123456789",
    PLATFORM_API_URL: "https://app.example.test/api/v1",
    MCPJAM_APP_ORIGIN: "https://app.example.test",
    MCPJAM_GUEST_ACCESS: "off",
    ...(withKey ? { POSTHOG_PROJECT_KEY: KEY } : {}),
  } as Env;
}

/** Captured PostHog payloads, and a ctx whose waitUntil work we await. */
function harness() {
  const captured: Array<Record<string, any>> = [];
  const pending: Promise<unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: unknown, init?: RequestInit) => {
      const url = target instanceof Request ? target.url : String(target);
      if (url === AUTHKIT_JWKS_URL) return Response.json(authkitJwks);
      if (url === CAPTURE_URL) {
        captured.push(JSON.parse(String(init?.body)));
        return new Response("{}");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    })
  );
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  // Drains work queued by other queued work (a deferred capture's own POST).
  const settle = async () => {
    let seen = -1;
    while (seen !== pending.length) {
      seen = pending.length;
      await Promise.all(pending);
    }
    return pending.length;
  };
  return { captured, ctx, settle };
}

async function authkitToken(expiresAt: string | number = "1h"): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "authkit" })
    .setIssuer(AUTHKIT_ISSUER)
    .setAudience(`${ORIGIN}/mcp`)
    .setSubject("user_123")
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(expiresAt)
    .sign(authkitKey);
}

function mcpRequest(
  method: string,
  params: Record<string, unknown>,
  bearer?: string
): Request {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Set by the HTTP layer in production; a test Request has none.
      "content-length": String(new TextEncoder().encode(body).length),
      accept: "application/json, text/event-stream",
      "user-agent": "node",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body,
  });
}

const INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "claude-code", version: "2.1.3" },
};

describe("worker usage events", () => {
  it("counts an agent identifying itself, and still serves the request", async () => {
    const { captured, ctx, settle } = harness();
    const response = await worker.fetch(
      mcpRequest("initialize", INITIALIZE, await authkitToken()),
      makeEnv(),
      ctx
    );
    expect(response.status).toBe(200);
    await settle();

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      api_key: KEY,
      event: "mcp_session_started",
      distinct_id: "user_123",
      properties: {
        mcp_client: "claude-code",
        protocol_version: "2025-06-18",
        is_guest: false,
        source: "mcp_worker",
      },
    });
    expect(JSON.stringify(captured[0])).not.toContain("2.1.3");
  });

  it("counts a token that did not verify, without a person", async () => {
    const { captured, ctx, settle } = harness();
    const response = await worker.fetch(
      mcpRequest("initialize", INITIALIZE, "not-a-jwt"),
      makeEnv(),
      ctx
    );
    expect(response.status).toBe(401);
    await settle();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      event: "mcp_request_rejected",
      properties: {
        reason: "invalid_token",
        mcp_client: "claude-code",
        $process_person_profile: false,
      },
    });
  });

  it("does not count an expired token, which the client refreshes", async () => {
    const { captured, ctx, settle } = harness();
    const expired = await authkitToken(Math.floor(Date.now() / 1000) - 3600);
    const response = await worker.fetch(
      mcpRequest("initialize", INITIALIZE, expired),
      makeEnv(),
      ctx
    );
    expect(response.status).toBe(401);
    await settle();
    expect(captured).toEqual([]);
  });

  it("does not count the OAuth challenge a new client gets", async () => {
    const { captured, ctx, settle } = harness();
    const response = await worker.fetch(
      mcpRequest("initialize", INITIALIZE),
      makeEnv(),
      ctx
    );
    expect(response.status).toBe(401);
    await settle();
    expect(captured).toEqual([]);
  });

  it("counts a skill read by its bundle name", async () => {
    const { captured, ctx, settle } = harness();
    const skill = SKILLS_BUNDLE_ENTRIES[0]!;
    await worker.fetch(
      mcpRequest("skills/get", { uri: skill.uri }, await authkitToken()),
      makeEnv(),
      ctx
    );
    await settle();
    expect(captured.map((c) => c.event)).toEqual(["mcp_skill_read"]);
    expect(captured[0]!.properties.skill_name).toBe(skill.frontmatter.name);
  });

  it("counts a 2026 client's session once, on server/discover", async () => {
    const { captured, ctx, settle } = harness();
    const meta = {
      _meta: {
        "io.modelcontextprotocol/clientInfo": { name: "cursor-vscode" },
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      },
    };
    const token = await authkitToken();
    await worker.fetch(mcpRequest("server/discover", meta, token), makeEnv(), ctx);
    await worker.fetch(mcpRequest("tools/list", meta, token), makeEnv(), ctx);
    await settle();
    expect(captured.map((c) => c.event)).toEqual(["mcp_session_started"]);
    expect(captured[0]!.properties).toMatchObject({
      mcp_client: "cursor",
      protocol_version: "2026-07-28",
    });
  });

  it("sends nothing without a PostHog key", async () => {
    const { captured, ctx, settle } = harness();
    await worker.fetch(
      mcpRequest("initialize", INITIALIZE, await authkitToken()),
      makeEnv(false),
      ctx
    );
    await settle();
    expect(captured).toEqual([]);
  });

  it("never lets a failed capture reach the request", async () => {
    const { ctx, settle } = harness();
    const served = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (target, init) => {
      if (String(target) === CAPTURE_URL) throw new Error("PostHog down");
      return served(target, init);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await worker.fetch(
      mcpRequest("initialize", INITIALIZE, await authkitToken()),
      makeEnv(),
      ctx
    );
    expect(response.status).toBe(200);
    await expect(settle()).resolves.toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(
      "[mcp] analytics capture failed",
      "Error: PostHog down"
    );
  });

  it("counts a failed guest mint against the guest", async () => {
    const { captured, ctx, settle } = harness();
    const caller = recordMcpRequest(
      createWorkerAnalytics(makeEnv(), ctx),
      { startsSession: false, clientName: "claude-code" },
      mcpRequest("tools/call", {}),
      { sub: "guest_abc", iss: GUEST_ISSUER },
      GUEST_ISSUER
    );
    caller.onGuestMintFailed();
    await settle();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      event: "mcp_request_rejected",
      distinct_id: "guest_abc",
      properties: {
        reason: "guest_mint_failed",
        mcp_client: "claude-code",
        is_guest: true,
      },
    });
  });
});

describe("readMcpRequestFacts", () => {
  it("reads a 2026 client's identity from the request _meta", async () => {
    const facts = await readMcpRequestFacts(
      mcpRequest("tools/list", {
        _meta: {
          "io.modelcontextprotocol/clientInfo": { name: "cursor-vscode" },
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        },
      })
    );
    expect(facts).toMatchObject({
      method: "tools/list",
      clientName: "cursor-vscode",
      protocolVersion: "2026-07-28",
      startsSession: false,
    });
  });

  it("names no skill outside this worker's bundle, and counts only SKILL.md", async () => {
    const skill = SKILLS_BUNDLE_ENTRIES[0]!;
    const reference = skill.uri.replace(/SKILL\.md$/, "references/guide.md");
    for (const [method, uri] of [
      ["resources/read", "skill://someone/else/SKILL.md"],
      ["resources/read", reference],
      ["skills/get", reference],
    ]) {
      const facts = await readMcpRequestFacts(mcpRequest(method!, { uri }));
      expect(facts.skillName).toBeUndefined();
    }
    const entry = await readMcpRequestFacts(
      mcpRequest("resources/read", { uri: skill.uri })
    );
    expect(entry.skillName).toBe(skill.frontmatter.name);
  });

  it("reads a body with no declared length, up to the cap", async () => {
    const request = mcpRequest("initialize", INITIALIZE);
    request.headers.delete("content-length");
    expect(await readMcpRequestFacts(request)).toMatchObject({
      clientName: "claude-code",
      startsSession: true,
    });

    const oversized = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      body: JSON.stringify({ method: "initialize", pad: "x".repeat(70_000) }),
    });
    expect(await readMcpRequestFacts(oversized)).toEqual({
      startsSession: false,
    });
    expect((await oversized.text()).length).toBeGreaterThan(70_000);
  });

  it("leaves the body for the handler, and shrugs at non-JSON", async () => {
    const request = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-length": "8" },
      body: "not json",
    });
    vi.spyOn(console, "debug").mockImplementation(() => {});
    expect(await readMcpRequestFacts(request)).toEqual({
      startsSession: false,
    });
    expect(await request.text()).toBe("not json");
  });
});
