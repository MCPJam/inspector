import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TLS_TRUST_FAILURE, UNREACHABLE_TARGET_FAILURE } from "@mcpjam/sdk";
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

  it("leaves other failures on the 500 path", async () => {
    const unknown = new Error("Unexpected end of JSON input");
    executeDebugOAuthProxyMock.mockRejectedValue(unknown);

    const { status, body } = await postDebugProxy(
      "https://mcp.example.com/mcp",
    );

    expect(status).toBe(500);
    expect(body.error).toBe(unknown.message);
  });
});

const ADVICE =
  "Check that the server is running and reachable from this machine.";
const DOCKER_HINT =
  "From Docker, use host.docker.internal instead of localhost or 127.0.0.1.";
const REFUSED = nodeError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:9");

describe("local OAuth debug proxy: unreachable server", () => {
  beforeEach(() => {
    executeDebugOAuthProxyMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers 502 naming the failed connection and keeps Node's text", async () => {
    executeDebugOAuthProxyMock.mockRejectedValue(REFUSED);

    const { status, body } = await postDebugProxy("http://127.0.0.1:9/mcp");

    expect(status).toBe(502);
    expect(body.error).toBe(
      `${UNREACHABLE_TARGET_FAILURE}: ${REFUSED.message}. ${ADVICE}`,
    );
    expect(body.normalized?.slug).toBe("transport/econnrefused");
  });

  it("answers 504 for a timeout", async () => {
    executeDebugOAuthProxyMock.mockRejectedValue(
      nodeError("ETIMEDOUT", "connect ETIMEDOUT 10.255.255.1:81"),
    );

    const { status } = await postDebugProxy("http://10.255.255.1:81/mcp");

    expect(status).toBe(504);
  });

  it("lists the addresses Node tried when its own message is empty", async () => {
    // `localhost` on Windows and macOS: ::1 and 127.0.0.1, both refused.
    executeDebugOAuthProxyMock.mockRejectedValue(
      Object.assign(
        new AggregateError(
          [
            nodeError("ECONNREFUSED", "connect ECONNREFUSED ::1:3000"),
            nodeError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:3000"),
          ],
          "",
        ),
        { code: "ECONNREFUSED" },
      ),
    );

    const { status, body } = await postDebugProxy("http://localhost:3000/mcp");

    expect(status).toBe(502);
    expect(body.error).toBe(
      `${UNREACHABLE_TARGET_FAILURE}: connect ECONNREFUSED ::1:3000; connect ECONNREFUSED 127.0.0.1:3000. ${ADVICE}`,
    );
  });

  it("keeps the 500 path for MCPJam's own hosts", async () => {
    executeDebugOAuthProxyMock.mockRejectedValue(REFUSED);

    const { status, body } = await postDebugProxy(
      "https://www.mcpjam.com/.well-known/oauth/client-metadata.json",
    );

    expect(status).toBe(500);
    expect(body.error).toBe(REFUSED.message);
  });

  it("adds the Docker hint for a loopback target inside the Docker image", async () => {
    vi.stubEnv("DOCKER_CONTAINER", "true");
    executeDebugOAuthProxyMock.mockRejectedValue(REFUSED);

    const { body } = await postDebugProxy("http://localhost:3000/mcp");

    expect(body.error).toBe(
      `${UNREACHABLE_TARGET_FAILURE}: ${REFUSED.message}. ${ADVICE} ${DOCKER_HINT}`,
    );
  });

  it.each([
    ["a LAN target inside Docker", "true", "http://192.168.1.20:3000/mcp"],
    ["a loopback target outside Docker", "false", "http://localhost:3000/mcp"],
  ])("leaves the Docker hint out for %s", async (_label, docker, url) => {
    vi.stubEnv("DOCKER_CONTAINER", docker);
    executeDebugOAuthProxyMock.mockRejectedValue(REFUSED);

    const { body } = await postDebugProxy(url);

    expect(body.error).not.toContain(DOCKER_HINT);
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

describe("local OAuth proxy and metadata routes: unreachable server", () => {
  beforeEach(() => {
    executeOAuthProxyMock.mockReset();
    fetchOAuthMetadataMock.mockReset();
  });

  it("answers 502 on /proxy", async () => {
    executeOAuthProxyMock.mockRejectedValue(REFUSED);

    const response = await app.request("/api/mcp/oauth/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:9/token" }),
    });

    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe(
      `${UNREACHABLE_TARGET_FAILURE}: ${REFUSED.message}. ${ADVICE}`,
    );
  });

  it("answers 504 on /metadata for a timeout", async () => {
    const timedOut = nodeError(
      "ETIMEDOUT",
      "connect ETIMEDOUT 10.255.255.1:81",
    );
    fetchOAuthMetadataMock.mockRejectedValue(timedOut);

    const response = await app.request(
      `/api/mcp/oauth/metadata?url=${encodeURIComponent(
        "http://10.255.255.1:81/.well-known/oauth-authorization-server",
      )}`,
    );

    expect(response.status).toBe(504);
    expect(((await response.json()) as { error: string }).error).toBe(
      `${UNREACHABLE_TARGET_FAILURE}: ${timedOut.message}. ${ADVICE}`,
    );
  });
});
