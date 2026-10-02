import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  createWebTestApp,
  expectJson,
  getJson,
  postJson,
} from "./helpers/test-app.js";

/**
 * MJ-001: what the hosted OAuth debugger's requests may send and what their
 * answers may carry back — `/api/web/oauth/proxy`, `/debug/proxy`,
 * `/metadata`, and the hosted Cross-App Access `/proxy/token`.
 *
 * The upstream answers are stubbed at the proxy executor, so these cases
 * assert on the route's own projection. `UNEXPECTED_MARKER_*` strings sit
 * everywhere an answer may carry data outside the allowlist.
 */

const {
  executeOAuthProxyMock,
  executeDebugOAuthProxyMock,
  fetchOAuthMetadataMock,
} = vi.hoisted(() => ({
  executeOAuthProxyMock: vi.fn(),
  executeDebugOAuthProxyMock: vi.fn(),
  fetchOAuthMetadataMock: vi.fn(),
}));

vi.mock("../../../utils/oauth-proxy.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/oauth-proxy.js")>();
  return {
    ...actual,
    executeOAuthProxy: executeOAuthProxyMock,
    executeDebugOAuthProxy: executeDebugOAuthProxyMock,
    fetchOAuthMetadata: fetchOAuthMetadataMock,
  };
});

import {
  initGuestTokenSecret,
  issueGuestToken,
} from "../../../services/guest-token.js";
import { createXaaRouter } from "../../mcp/xaa.js";
import { MAX_HOSTED_OAUTH_BODY_BYTES } from "../../../utils/hosted-oauth-proxy.js";

initGuestTokenSecret();

const MARKER = /UNEXPECTED_MARKER/;
const TOKEN_URL = "https://as.example.test/token";

const EXTRA_HEADERS = {
  "set-cookie": "sid=UNEXPECTED_MARKER_COOKIE",
  "x-upstream-trace": "UNEXPECTED_MARKER_HEADER",
  server: "UNEXPECTED_MARKER_SERVER",
};

function upstream(
  headers: Record<string, string>,
  body: unknown,
  status = 200,
) {
  return {
    status,
    statusText: status === 200 ? "OK" : "Method Not Allowed",
    headers: { ...EXTRA_HEADERS, ...headers },
    body,
    finalUrl: TOKEN_URL,
    targetIsPrivate: false,
  };
}

const { app, token } = createWebTestApp();

beforeEach(() => {
  executeOAuthProxyMock.mockReset();
  executeDebugOAuthProxyMock.mockReset();
  fetchOAuthMetadataMock.mockReset();
});

describe.each([
  ["proxy", "/api/web/oauth/proxy", executeOAuthProxyMock],
  ["debug proxy", "/api/web/oauth/debug/proxy", executeDebugOAuthProxyMock],
] as const)("hosted OAuth %s", (_name, path, executor) => {
  const proxy = (body: Record<string, unknown>, bearer = token) =>
    postJson(app, path, { url: TOKEN_URL, ...body }, bearer);

  it("omits an HTML answer and keeps only the headers the flows read", async () => {
    executor.mockResolvedValueOnce(
      upstream(
        {
          "content-type": "text/html; charset=utf-8",
          "www-authenticate":
            'Bearer resource_metadata="https://mcp.example.test/prm"',
        },
        "<html><body>UNEXPECTED_MARKER_BODY</body></html>",
        405,
      ),
    );
    const { status, data } = await expectJson<any>(
      await proxy({ method: "POST", body: { a: 1 } }),
    );
    expect(status).toBe(200);
    expect(JSON.stringify(data)).not.toMatch(MARKER);
    expect(data).toEqual({
      status: 405,
      statusText: "Method Not Allowed",
      headers: {
        "content-type": "text/html; charset=utf-8",
        "www-authenticate":
          'Bearer resource_metadata="https://mcp.example.test/prm"',
      },
      body: { bodyOmitted: true, contentType: "text/html", bytes: 48 },
      finalUrl: TOKEN_URL,
    });
  });

  it("returns a JSON answer, re-serialized", async () => {
    executor.mockResolvedValueOnce(
      upstream(
        { "content-type": "application/json; charset=utf-8" },
        { access_token: "at", token_type: "Bearer", expires_in: 3600 },
      ),
    );
    const { data } = await expectJson<any>(
      await proxy({
        method: "POST",
        body: { grant_type: "client_credentials" },
      }),
    );
    expect(data.body).toEqual({
      access_token: "at",
      token_type: "Bearer",
      expires_in: 3600,
    });
    expect(data.headers).toEqual({
      "content-type": "application/json; charset=utf-8",
    });
  });

  it("returns a +json answer", async () => {
    executor.mockResolvedValueOnce(
      upstream(
        { "content-type": "application/problem+json" },
        { error: "invalid_request" },
      ),
    );
    const { data } = await expectJson<any>(await proxy({}));
    expect(data.body).toEqual({ error: "invalid_request" });
  });

  it("omits a JSON-typed answer that is not JSON", async () => {
    executor.mockResolvedValueOnce(
      upstream(
        { "content-type": "application/json" },
        "UNEXPECTED_MARKER_TEXT",
      ),
    );
    const { data } = await expectJson<any>(await proxy({}));
    expect(data.body).toEqual({
      bodyOmitted: true,
      contentType: "application/json",
      bytes: 22,
    });
  });

  it("omits a JSON answer over the cap", async () => {
    const large = {
      blob: `${"x".repeat(MAX_HOSTED_OAUTH_BODY_BYTES)}UNEXPECTED_MARKER`,
    };
    executor.mockResolvedValueOnce(
      upstream({ "content-type": "application/json" }, large),
    );
    const { data } = await expectJson<any>(await proxy({}));
    expect(JSON.stringify(data)).not.toMatch(MARKER);
    expect(data.body.bodyOmitted).toBe(true);
    expect(data.body.bytes).toBeGreaterThan(MAX_HOSTED_OAUTH_BODY_BYTES);
  });

  it("returns a form-encoded answer", async () => {
    executor.mockResolvedValueOnce(
      upstream(
        { "content-type": "application/x-www-form-urlencoded" },
        "access_token=at&token_type=bearer&scope=read%20write",
      ),
    );
    const { data } = await expectJson<any>(await proxy({ method: "POST" }));
    expect(data.body).toBe(
      "access_token=at&token_type=bearer&scope=read+write",
    );
  });

  it.each(["PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", 7])(
    "refuses method %s before sending anything",
    async (method) => {
      const { status, data } = await expectJson<any>(await proxy({ method }));
      expect(status).toBe(400);
      expect(data.code).toBe("VALIDATION_ERROR");
      expect(executor).not.toHaveBeenCalled();
    },
  );

  it("sends GET and POST, in any case", async () => {
    for (const method of ["get", "post", undefined]) {
      executor.mockResolvedValueOnce(
        upstream({ "content-type": "application/json" }, {}),
      );
      const { status } = await expectJson(await proxy({ method }));
      expect(status).toBe(200);
    }
    expect(executor.mock.calls.map(([req]) => req.method)).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });

  it("drops cookie, connection and forwarding headers", async () => {
    executor.mockResolvedValueOnce(
      upstream({ "content-type": "application/json" }, {}),
    );
    await proxy({
      method: "POST",
      headers: {
        Authorization: "Basic abc",
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Cookie: "sid=1",
        Connection: "keep-alive",
        "Transfer-Encoding": "chunked",
        Host: "internal.example.test",
        "X-Forwarded-For": "10.0.0.1",
        "Proxy-Authorization": "Basic def",
      },
    });
    expect(executor.mock.calls[0][0].headers).toEqual({
      Authorization: "Basic abc",
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    });
  });

  it("refuses headers that are not a string map", async () => {
    const { status } = await expectJson(
      await proxy({ headers: { "X-Count": 3 } }),
    );
    expect(status).toBe(400);
    expect(executor).not.toHaveBeenCalled();
  });

  it("serves a guest session", async () => {
    executor.mockResolvedValueOnce(
      upstream({ "content-type": "application/json" }, { ok: true }),
    );
    const { status, data } = await expectJson<any>(
      await proxy({}, issueGuestToken().token),
    );
    expect(status).toBe(200);
    expect(data.body).toEqual({ ok: true });
  });
});

describe("hosted OAuth debug proxy event streams", () => {
  it("keeps the JSON events of an event-stream answer", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "s" } },
    };
    executeDebugOAuthProxyMock.mockResolvedValueOnce(
      upstream(
        { "content-type": "text/event-stream" },
        {
          transport: "sse",
          events: [
            { event: "message", id: "1", data: mcpResponse },
            { event: "note", data: "UNEXPECTED_MARKER_TEXT_EVENT" },
          ],
          isOldTransport: false,
          endpoint: null,
          mcpResponse,
          rawBuffer: "data: UNEXPECTED_MARKER_RAW",
        },
      ),
    );
    const { data } = await expectJson<any>(
      await postJson(
        app,
        "/api/web/oauth/debug/proxy",
        { url: TOKEN_URL, method: "POST" },
        token,
      ),
    );
    expect(JSON.stringify(data)).not.toMatch(MARKER);
    expect(data.body).toEqual({
      transport: "sse",
      events: [
        { event: "message", id: "1", data: mcpResponse },
        { event: "note" },
      ],
      isOldTransport: false,
      mcpResponse,
    });
  });

  it("omits an event-stream answer on the non-debug proxy", async () => {
    executeOAuthProxyMock.mockResolvedValueOnce(
      upstream(
        { "content-type": "text/event-stream" },
        "event: message\ndata: UNEXPECTED_MARKER_SSE\n\n",
      ),
    );
    const { data } = await expectJson<any>(
      await postJson(app, "/api/web/oauth/proxy", { url: TOKEN_URL }, token),
    );
    expect(JSON.stringify(data)).not.toMatch(MARKER);
    expect(data.body.bodyOmitted).toBe(true);
  });
});

describe("hosted OAuth metadata", () => {
  const metadata = (bearer = token) =>
    getJson(
      app,
      `/api/web/oauth/metadata?url=${encodeURIComponent(
        "https://as.example.test/.well-known/oauth-authorization-server",
      )}`,
      bearer,
    );

  it("returns a metadata document", async () => {
    fetchOAuthMetadataMock.mockResolvedValueOnce({
      metadata: {
        issuer: "https://as.example.test",
        token_endpoint: TOKEN_URL,
      },
      finalUrl:
        "https://as.example.test/.well-known/oauth-authorization-server",
    });
    const { status, data } = await expectJson<any>(await metadata());
    expect(status).toBe(200);
    expect(data).toEqual({
      issuer: "https://as.example.test",
      token_endpoint: TOKEN_URL,
    });
  });

  it.each([
    ["an array", ["UNEXPECTED_MARKER_ARRAY"]],
    [
      "a document over the cap",
      { blob: `${"x".repeat(MAX_HOSTED_OAUTH_BODY_BYTES)}UNEXPECTED_MARKER` },
    ],
  ])("refuses %s", async (_kind, value) => {
    fetchOAuthMetadataMock.mockResolvedValueOnce({
      metadata: value,
      finalUrl:
        "https://as.example.test/.well-known/oauth-authorization-server",
    });
    const { status, data } = await expectJson<any>(await metadata());
    expect(status).toBe(502);
    expect(JSON.stringify(data)).not.toMatch(MARKER);
  });

  it("bounds an upstream status text in its failure", async () => {
    fetchOAuthMetadataMock.mockResolvedValueOnce({
      status: 404,
      statusText: `Not Found ${"n".repeat(500)}UNEXPECTED_MARKER`,
    });
    const { status, data } = await expectJson<any>(await metadata());
    expect(status).toBe(404);
    expect(JSON.stringify(data)).not.toMatch(MARKER);
  });
});

describe("hosted Cross-App Access token proxy", () => {
  const xaa = new Hono();
  xaa.route(
    "/api/web/xaa",
    createXaaRouter({ issuerBasePath: "/api/web", httpsOnlyProxy: true }),
  );
  const local = new Hono();
  local.route(
    "/api/mcp/xaa",
    createXaaRouter({ issuerBasePath: "/api/mcp", httpsOnlyProxy: false }),
  );

  const redeem = (router: Hono, base: string) =>
    router.request(`${base}/proxy/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer member",
      },
      body: JSON.stringify({
        tokenEndpoint: TOKEN_URL,
        assertion: "the.id.jag",
        clientId: "client",
        clientSecret: "secret",
        headers: { Cookie: "sid=1", "X-Tenant": "t1" },
      }),
    });

  it("reduces the answer and drops cookie headers", async () => {
    executeOAuthProxyMock.mockResolvedValueOnce(
      upstream(
        { "content-type": "text/html" },
        "<html>UNEXPECTED_MARKER_XAA</html>",
        405,
      ),
    );
    const res = await redeem(xaa, "/api/web/xaa");
    const data = (await res.json()) as any;
    expect(JSON.stringify(data)).not.toMatch(MARKER);
    expect(data.body.bodyOmitted).toBe(true);
    expect(data.headers).toEqual({ "content-type": "text/html" });
    const sent = executeOAuthProxyMock.mock.calls[0][0].headers;
    expect(sent["X-Tenant"]).toBe("t1");
    expect(sent).not.toHaveProperty("Cookie");
  });

  it("returns the answer unchanged on the local router", async () => {
    executeOAuthProxyMock.mockResolvedValueOnce(
      upstream({ "content-type": "text/html" }, "<html>local</html>", 405),
    );
    const res = await redeem(local, "/api/mcp/xaa");
    const data = (await res.json()) as any;
    expect(data.body).toBe("<html>local</html>");
    expect(executeOAuthProxyMock.mock.calls[0][0].headers.Cookie).toBe("sid=1");
  });
});
