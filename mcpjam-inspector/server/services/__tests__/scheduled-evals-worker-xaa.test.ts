import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A scheduled run against a Cross-App Access server, through the REAL manager
// builder and the REAL mint. Only the outer boundaries are fakes: Convex (the
// authorize batch, the run lifecycle), the authorization server (its metadata
// and token endpoint), and the MCP transport, which records the config it was
// handed instead of dialling.

const {
  mcpClientManagerMock,
  executeOAuthProxyMock,
  fetchOAuthMetadataMock,
  prepareEvalRun,
} = vi.hoisted(() => ({
  mcpClientManagerMock: vi.fn(),
  executeOAuthProxyMock: vi.fn(),
  fetchOAuthMetadataMock: vi.fn(),
  prepareEvalRun: vi.fn(),
}));

vi.mock("../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config.js")>()),
  HOSTED_MODE: true,
}));
vi.mock("@mcpjam/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcpjam/sdk")>()),
  MCPClientManager: mcpClientManagerMock.mockImplementation(function () {
    return { disconnectAllServers: vi.fn().mockResolvedValue(undefined) };
  }),
}));
vi.mock("../../utils/oauth-proxy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/oauth-proxy.js")>()),
  executeOAuthProxy: executeOAuthProxyMock,
  fetchOAuthMetadata: fetchOAuthMetadataMock,
  validateUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../utils/v1-convex-token.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/v1-convex-token.js")>()),
  getConvexBearerForDelegation: vi.fn().mockResolvedValue("delegated-bearer"),
}));
vi.mock("../../routes/v1/evals.js", () => ({
  fetchSuiteRunServerSelection: vi
    .fn()
    .mockResolvedValue({ serverIds: ["srv-xaa"], serverNames: ["Tickets"] }),
}));
vi.mock("../../routes/shared/evals.js", () => ({
  prepareEvalRun: (...args: unknown[]) => prepareEvalRun(...args),
  shouldSkipExecution: () => false,
}));
vi.mock("../evals/compat-runtime.js", () => ({
  loadSuiteHostConfig: vi.fn().mockResolvedValue({}),
}));

import { executeClaimedRun } from "../scheduled-evals-worker";

const CLAIM = {
  triggerId: "trig-xaa",
  suiteId: "suite-1",
  suiteName: "Tickets monitor",
  organizationId: "org-1",
  projectId: "proj-1",
  createdByExternalId: "user_workos_1",
  scheduledFor: 1700000000000,
};

const RESOURCE = "https://mcp.tickets.example.com/mcp";
const AUTHZ_ISSUER = "https://auth.tickets.example.com";

function decodeJwt(token: string) {
  const [header, payload, signature] = token.split(".");
  return {
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature, "base64url"),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  };
}

describe("scheduled run against an XAA server", () => {
  const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let backendCalls: string[];

  beforeEach(() => {
    vi.stubEnv("CONVEX_URL", "https://convex.test");
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
    vi.stubEnv("MCPJAM_INSPECTOR_PUBLIC_URL", "https://app.example.com");
    // The deployment's shared signing key: what the web tier's JWKS publishes.
    vi.stubEnv(
      "XAA_IDP_PRIVATE_KEY",
      signingKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );

    backendCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        backendCalls.push(new URL(url).pathname);
        if (url.endsWith("/web/authorize-batch")) {
          return Response.json({
            organizationId: "org-1",
            isAnonymous: false,
            results: {
              "srv-xaa": {
                ok: true,
                role: "member",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: {
                  transportType: "http",
                  url: RESOURCE,
                  authMethod: "xaa",
                  registrationMode: "cimd",
                  xaaAuthzIssuer: AUTHZ_ISSUER,
                },
              },
            },
          });
        }
        return Response.json({ ok: true });
      }),
    );

    fetchOAuthMetadataMock.mockResolvedValue({
      metadata: {
        issuer: AUTHZ_ISSUER,
        token_endpoint: `${AUTHZ_ISSUER}/token`,
        grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
        client_id_metadata_document_supported: true,
      },
    });
    executeOAuthProxyMock.mockResolvedValue({
      status: 200,
      body: { access_token: "xaa-access-token", token_type: "Bearer" },
    });
    prepareEvalRun.mockResolvedValue({
      runId: "run-xaa",
      suiteId: "suite-1",
      execute: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("mints under the organization's issuer on the public origin and connects with the token", async () => {
    await executeClaimedRun(CLAIM);

    // The jwt-bearer grant went to the server's authorization server, carrying
    // an ID-JAG that names the issuer an interactive run in org-1 names.
    expect(executeOAuthProxyMock).toHaveBeenCalledTimes(1);
    const grant = executeOAuthProxyMock.mock.calls[0][0];
    expect(grant.url).toBe(`${AUTHZ_ISSUER}/token`);
    expect(grant.body.grant_type).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const idJag = decodeJwt(grant.body.assertion);
    expect(idJag.payload).toMatchObject({
      iss: "https://app.example.com/api/web/xaa/o/org-1",
      aud: AUTHZ_ISSUER,
      resource: RESOURCE,
    });
    // Signed with the deployment's key, so the JWKS the web tier serves under
    // that issuer verifies it.
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(idJag.signingInput),
        signingKey.publicKey,
        idJag.signature,
      ),
    ).toBe(true);

    // The server was connected with the minted token, and the run went ahead.
    const configs = mcpClientManagerMock.mock.calls[0][0];
    expect(configs["srv-xaa"].requestInit.headers.Authorization).toBe(
      "Bearer xaa-access-token",
    );
    expect(prepareEvalRun).toHaveBeenCalledTimes(1);
    expect(backendCalls.at(-1)).toBe(
      "/internal/v1/scheduled-eval-runs/complete",
    );
    const completion = JSON.parse(
      String(vi.mocked(fetch).mock.calls.at(-1)![1]!.body),
    );
    expect(completion).toMatchObject({ ok: true, runId: "run-xaa" });
  });

  it("fails the run closed when the deployment configures no public URL", async () => {
    vi.stubEnv("MCPJAM_INSPECTOR_PUBLIC_URL", "");
    vi.stubEnv("BASE_URL", "");

    await executeClaimedRun(CLAIM);

    // No issuer means no mint, and no tokenless connect either.
    expect(executeOAuthProxyMock).not.toHaveBeenCalled();
    expect(mcpClientManagerMock).not.toHaveBeenCalled();
    expect(prepareEvalRun).not.toHaveBeenCalled();
    const completion = JSON.parse(
      String(vi.mocked(fetch).mock.calls.at(-1)![1]!.body),
    );
    expect(completion.ok).toBe(false);
    expect(completion.failureReason).toContain("Missing XAA issuer");
  });
});
