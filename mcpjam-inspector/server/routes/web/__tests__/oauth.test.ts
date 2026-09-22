import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebTestApp,
  expectJson,
  getJson,
  postJson,
} from "./helpers/test-app.js";

const { executeOAuthProxyMock, fetchOAuthMetadataMock } = vi.hoisted(() => ({
  executeOAuthProxyMock: vi.fn(),
  fetchOAuthMetadataMock: vi.fn(),
}));

vi.mock("../../../utils/oauth-proxy.js", () => ({
  executeOAuthProxy: executeOAuthProxyMock,
  fetchOAuthMetadata: fetchOAuthMetadataMock,
  OAuthProxyError: class OAuthProxyError extends Error {
    status: number;

    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { OAuthProxyError } from "../../../utils/oauth-proxy.js";
import { initGuestTokenSecret } from "../../../services/guest-token.js";

// Guest token secret must be initialized before oauth routes validate tokens
initGuestTokenSecret();

interface OAuthErrorResponse {
  code: string;
  message: string;
  /** Legacy compatibility key — see `webErrorCompat`. */
  error: string;
  /** Attribution, now that these routes serialize through `webErrorFromRoute`. */
  origin?: string;
  normalized?: { slug?: string };
}

/**
 * The compat keys these routes have always returned. Asserted alongside the
 * new attribution fields rather than with a bare `toEqual`, so an accidental
 * REMOVAL of `error`/`code`/`message` still fails while an additive envelope
 * change does not.
 */
function expectCompatBody(
  data: OAuthErrorResponse,
  code: string,
  message: string,
) {
  expect(data.code).toBe(code);
  expect(data.message).toBe(message);
  expect(data.error).toBe(message);
}

describe("web routes — oauth requires bearer token", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    executeOAuthProxyMock.mockReset();
    fetchOAuthMetadataMock.mockReset();
  });

  it("POST /proxy returns 401 without bearer token", async () => {
    const response = await postJson(app, "/api/web/oauth/proxy", {
      url: "https://example.com/token",
    });
    const { status, data } = await expectJson(response);

    expect(status).toBe(401);
    expect(data).toEqual({
      code: "UNAUTHORIZED",
      message: "Bearer token required",
    });
  });

  it("GET /metadata returns 401 without bearer token", async () => {
    const response = await getJson(
      app,
      "/api/web/oauth/metadata?url=https://example.com/.well-known/oauth",
    );
    const { status, data } = await expectJson(response);

    expect(status).toBe(401);
    expect(data).toEqual({
      code: "UNAUTHORIZED",
      message: "Bearer token required",
    });
  });

  it("POST /proxy succeeds with bearer token", async () => {
    executeOAuthProxyMock.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { ok: true },
      finalUrl: "https://example.com/token",
    });

    const response = await postJson(
      app,
      "/api/web/oauth/proxy",
      { url: "https://example.com/token" },
      token,
    );
    const { status, data } = await expectJson(response);

    expect(status).toBe(200);
    expect(data).toEqual({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { ok: true },
      finalUrl: "https://example.com/token",
    });
    expect(response.headers.get("x-mcpjam-oauth-upstream-url")).toBe(
      "https://example.com/token"
    );
  });

  it("GET /metadata succeeds with bearer token", async () => {
    fetchOAuthMetadataMock.mockResolvedValueOnce({
      metadata: { issuer: "https://example.com" },
      finalUrl: "https://example.com/.well-known/oauth",
    });

    const response = await getJson(
      app,
      "/api/web/oauth/metadata?url=https://example.com/.well-known/oauth",
      token,
    );
    const { status, data } = await expectJson(response);

    expect(status).toBe(200);
    expect(data).toEqual({ issuer: "https://example.com" });
    expect(response.headers.get("x-mcpjam-oauth-upstream-url")).toBe(
      "https://example.com/.well-known/oauth"
    );
  });
});

describe("web routes — oauth error contract", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    executeOAuthProxyMock.mockReset();
    fetchOAuthMetadataMock.mockReset();
  });

  it("returns compatibility payload for OAuthProxyError on /proxy", async () => {
    executeOAuthProxyMock.mockRejectedValueOnce(
      new OAuthProxyError(400, "Invalid URL format"),
    );

    const response = await postJson(
      app,
      "/api/web/oauth/proxy",
      { url: "bad-url" },
      token,
    );
    const { status, data } = await expectJson<OAuthErrorResponse>(response);

    expect(status).toBe(400);
    expectCompatBody(data, "VALIDATION_ERROR", "Invalid URL format");
    // A 400 from our own validation is not evidence of an MCPJam fault, and
    // these routes declare no internal boundary — so it must never read
    // `mcpjam`. It carries attribution regardless: before this, the row had
    // none at all.
    expect(data.origin).toBeDefined();
    expect(data.origin).not.toBe("mcpjam");
  });

  it("returns compatibility payload for missing metadata url", async () => {
    const response = await getJson(app, "/api/web/oauth/metadata", token);
    const { status, data } = await expectJson<OAuthErrorResponse>(response);

    expect(status).toBe(400);
    expectCompatBody(data, "VALIDATION_ERROR", "Missing url parameter");
    expect(data.origin).not.toBe("mcpjam");
  });

  it("returns compatibility payload for metadata upstream status errors", async () => {
    fetchOAuthMetadataMock.mockResolvedValueOnce({
      status: 502,
      statusText: "Bad Gateway",
    });

    const response = await getJson(
      app,
      "/api/web/oauth/metadata?url=https://oauth.example/.well-known/oauth",
      token,
    );
    const { status, data } = await expectJson<OAuthErrorResponse>(response);

    expect(status).toBe(502);
    expectCompatBody(
      data,
      "SERVER_UNREACHABLE",
      "Failed to fetch OAuth metadata: 502 Bad Gateway",
    );
    // THE POINT OF THIS CHANGE. This route reaches the USER's authorization
    // server, so a 502 from it is theirs — it must be attributed (it used to
    // log as a bare `internal_error` with no origin at all) and it must not be
    // attributed to us, or the MCPJam-fault monitor pages on third-party
    // downtime.
    expect(data.origin).toBeDefined();
    expect(data.origin).not.toBe("mcpjam");
    expect(data.normalized?.slug).toBeDefined();
  });

  it("returns compatibility payload for generic runtime errors", async () => {
    executeOAuthProxyMock.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED"),
    );

    const response = await postJson(
      app,
      "/api/web/oauth/proxy",
      { url: "https://oauth.example/token", method: "POST", body: {} },
      token,
    );
    const { status, data } = await expectJson<OAuthErrorResponse>(response);

    expect(status).toBe(502);
    // mapRuntimeError frames connection-class failures as a target-server
    // problem (the raw errno alone reads like an MCPJam outage in the client
    // toast) while preserving the raw error for debugging.
    expect(data.code).toBe("SERVER_UNREACHABLE");
    expect(data.message).toContain("connect ECONNREFUSED");
    expect(data.message).toContain("not an MCPJam outage");
    expect(data.error).toBe(data.message);
  });
});

describe("web routes — oauth session forwarding", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("POST /session forwards the bearer-authenticated session bootstrap to Convex", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, sessionId: "session-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const payload = {
      projectId: "ws_1",
      serverId: "srv_1",
      codeVerifier: "verifier",
      redirectUri: "http://localhost:5173/oauth/callback",
      clientInformation: {
        clientId: "client-id",
      },
    };

    const response = await postJson(app, "/api/web/oauth/session", payload, token);
    const { status, data } = await expectJson(response);

    expect(status).toBe(200);
    expect(data).toEqual({ success: true, sessionId: "session-123" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.convex.site/web/oauth/session",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      },
    );
  });

  it("POST /tokens forwards the bearer-authenticated token reveal to Convex", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          tokens: {
            access_token: "access-token",
            refresh_token: "refresh-token",
          },
          expiresAt: null,
          kind: "generic",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const payload = {
      projectId: "ws_1",
      serverId: "srv_1",
    };

    const response = await postJson(app, "/api/web/oauth/tokens", payload, token);
    const { status, data } = await expectJson(response);

    expect(status).toBe(200);
    expect(data).toEqual({
      success: true,
      tokens: {
        access_token: "access-token",
        refresh_token: "refresh-token",
      },
      expiresAt: null,
      kind: "generic",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.convex.site/web/oauth/tokens",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      },
    );
  });
});
