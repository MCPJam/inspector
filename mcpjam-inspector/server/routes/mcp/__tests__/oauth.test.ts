import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TLS_TRUST_FAILURE } from "@mcpjam/sdk";
import { requestLogContextMiddleware } from "../../../middleware/request-log-context.js";

const {
  executeDebugOAuthProxyMock,
  executeOAuthProxyMock,
  fetchOAuthMetadataMock,
} = vi.hoisted(() => ({
  executeDebugOAuthProxyMock: vi.fn(),
  executeOAuthProxyMock: vi.fn(),
  fetchOAuthMetadataMock: vi.fn(),
}));

vi.mock("../../../utils/oauth-proxy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/oauth-proxy.js")>()),
  executeDebugOAuthProxy: executeDebugOAuthProxyMock,
  executeOAuthProxy: executeOAuthProxyMock,
  fetchOAuthMetadata: fetchOAuthMetadataMock,
}));

import oauth from "../oauth.js";

/** What the pinned transport rejects with: Node's text, OpenSSL's code. */
function nodeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const UNTRUSTED_LEAF = nodeError(
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca",
);

const app = new Hono()
  .use("/api/*", requestLogContextMiddleware)
  .route("/api/mcp/oauth", oauth);

async function postDebugProxy(url: string) {
  const response = await app.request("/api/mcp/oauth/debug/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, method: "POST" }),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      error: string;
      normalized?: { slug: string };
      origin?: string;
    },
  };
}

describe("local OAuth debug proxy: certificate failures", () => {
  beforeEach(() => {
    executeDebugOAuthProxyMock.mockReset();
  });

  it("answers 502 naming the server's certificate and keeps Node's hint", async () => {
    executeDebugOAuthProxyMock.mockRejectedValue(UNTRUSTED_LEAF);

    const { status, body } = await postDebugProxy(
      "https://mcp.example.com/mcp",
    );

    expect(status).toBe(502);
    expect(body.error).toBe(`${TLS_TRUST_FAILURE}: ${UNTRUSTED_LEAF.message}`);
    expect(body.normalized?.slug).toBe("transport/tls_untrusted");
    expect(body.origin).toBe("user_server");
  });

  it("keeps the 500 path for MCPJam's own hosts", async () => {
    // The debugger fetches MCPJam's client metadata document through this
    // proxy. A certificate failure there is ours, not the server under test's.
    executeDebugOAuthProxyMock.mockRejectedValue(UNTRUSTED_LEAF);

    const { status, body } = await postDebugProxy(
      "https://www.mcpjam.com/.well-known/oauth/client-metadata.json",
    );

    expect(status).toBe(500);
    expect(body.error).toBe(UNTRUSTED_LEAF.message);
  });

  it("leaves other transport failures on the 500 path", async () => {
    const refused = nodeError(
      "ECONNREFUSED",
      "connect ECONNREFUSED 127.0.0.1:9",
    );
    executeDebugOAuthProxyMock.mockRejectedValue(refused);

    const { status, body } = await postDebugProxy(
      "https://mcp.example.com/mcp",
    );

    expect(status).toBe(500);
    expect(body.error).toBe(refused.message);
  });
});

describe("local OAuth proxy and metadata routes: certificate failures", () => {
  beforeEach(() => {
    executeOAuthProxyMock.mockReset();
    fetchOAuthMetadataMock.mockReset();
  });

  it("answers 502 on /proxy", async () => {
    executeOAuthProxyMock.mockRejectedValue(UNTRUSTED_LEAF);

    const response = await app.request("/api/mcp/oauth/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://auth.example.com/token" }),
    });

    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe(
      `${TLS_TRUST_FAILURE}: ${UNTRUSTED_LEAF.message}`,
    );
  });

  it("answers 502 on /metadata", async () => {
    fetchOAuthMetadataMock.mockRejectedValue(UNTRUSTED_LEAF);

    const response = await app.request(
      `/api/mcp/oauth/metadata?url=${encodeURIComponent(
        "https://auth.example.com/.well-known/oauth-authorization-server",
      )}`,
    );

    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe(
      `${TLS_TRUST_FAILURE}: ${UNTRUSTED_LEAF.message}`,
    );
  });
});
