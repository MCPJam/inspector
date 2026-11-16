// @vitest-environment node
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Hono } from "hono";
import http from "node:http";
import { generateKeyPair, SignJWT } from "jose";
import type { AuthKitVerifyDeps } from "../../authkit-jwt.js";
const verification = vi.hoisted(() => ({
  deps: undefined as AuthKitVerifyDeps | undefined,
}));
vi.mock("../../../config.js", async (original) => ({
  ...(await original<typeof import("../../../config.js")>()),
  HOSTED_MODE: true,
}));
vi.mock("../../authkit-jwt.js", async (original) => {
  const actual = await original<typeof import("../../authkit-jwt.js")>();
  return {
    ...actual,
    verifyAuthKitToken: (
      token: string,
      _deps: AuthKitVerifyDeps | undefined,
      options: { allowMcpResourceAudience?: boolean },
    ) => actual.verifyAuthKitToken(token, verification.deps, options),
  };
});
vi.mock("../resolve-hosted-chat-setup.js", () => ({
  resolveHostedChatSetup: async () => ({
    mode: "interactive",
    hostRuntimeConfig: {},
    environmentSpec: null,
    scenarioEnvironment: null,
    effectiveCapabilities: null,
    clientTurn: false,
    attribution: null,
    pluginDisabled: [],
    authoritativeConnectionPolicy: false,
    pinsEnvironment: false,
    authoritativeCapabilities: false,
    toolConfiguration: null,
    toolConfigurationUnavailable: false,
    workspaceToolsBarred: false,
  }),
}));
vi.mock("../../../utils/built-in-tools/built-in-tool-policy.js", () => ({
  resolveTurnBuiltInToolIds: async () => ({ ids: [], dropped: [] }),
}));
vi.mock("../../../utils/harness/local/run-resources.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/harness/local/run-resources.js")
  >()),
  shouldUseLocalHarness: async () => false,
}));
vi.mock("../../../utils/skill-tools.js", async (original) => ({
  ...(await original<typeof import("../../../utils/skill-tools.js")>()),
  listLocalRuntimeSkills: async () => [],
}));
import { resolveManagedTurnSetup } from "../managed-setup.js";
import { getBackgroundRunBearerForRequest } from "../../../utils/v1-convex-token.js";
import { createHostedRpcLogCollector } from "../../../routes/web/hosted-rpc-logs.js";
import {
  RevokedSessionCache,
  setRevokedSessionCacheForTests,
} from "../../revoked-session-cache.js";
const issuer = "https://login.mcpjam.com";
const clientId = "client_01K4C1TVPBE7JTBFQJF9SDW9P9";
const requests: {
  path: string;
  authorization?: string;
  organization?: string;
}[] = [];
let backend: http.Server;
let backendUrl: string;
let token: string;
let replacementToken: string;
let session: string;
let tokenIndex = 0;
let legacyAuthorization = false;
let revoked: RevokedSessionCache;
let sign: (subject: string, sid: string) => Promise<string>;
beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  verification.deps = {
    clientId,
    resolveKey: (value) => (value === issuer ? publicKey : null),
  };
  sign = (subject, sid) =>
    new SignJWT({ sid })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(issuer)
      .setSubject(subject)
      .setAudience(clientId)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  backend = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    requests.push({
      path,
      authorization: req.headers.authorization,
      organization: String(req.headers["x-mcpjam-acting-in-org"] ?? ""),
    });
    res.setHeader("content-type", "application/json");
    if (path === "/web/authorize-project") {
      res.end(
        JSON.stringify({
          organizationId: "authorized-org",
          ...(legacyAuthorization ? {} : { projectRole: "editor" }),
        }),
      );
    } else if (path === "/api/query") {
      res.end(
        JSON.stringify({
          status: "success",
          value: [
            { _id: "project-1", organizationId: "lookup-org" },
            { _id: "project-2", organizationId: "second-project-org" },
          ],
        }),
      );
    } else if (path === "/web/delegated-token") {
      res.end(
        JSON.stringify({
          ok: true,
          token: "fixture-delegation",
          expiresAt: Date.now() + 2 * 60 * 60 * 1000,
        }),
      );
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Unexpected fixture path" }));
    }
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  backendUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  backend.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    backend.close((error) => (error ? reject(error) : resolve())),
  );
  setRevokedSessionCacheForTests(undefined);
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  requests.length = 0;
  legacyAuthorization = false;
  session = `session-${++tokenIndex}`;
  token = await sign(`user-${tokenIndex}`, session);
  replacementToken = await sign(
    `replacement-${tokenIndex}`,
    `${session}-replacement`,
  );
  revoked = new RevokedSessionCache({
    fetchPage: async () => ({
      sessions: [],
      cursor: null,
      isDone: true,
      watermark: Date.now(),
    }),
  });
  await revoked.scan();
  setRevokedSessionCacheForTests(revoked);
  vi.stubEnv("CONVEX_URL", backendUrl);
  vi.stubEnv("CONVEX_HTTP_URL", backendUrl);
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "fixture-service");
});
function app() {
  return new Hono().post("/:mode", async (c) => {
    c.set("authMethod", "authkit_jwt");
    const mode = c.req.param("mode");
    try {
      if (mode !== "no-setup") {
        const setup = await resolveManagedTurnSetup({
          c,
          bearerToken: token,
          localIngress: true,
          rawBody: {
            projectId: "project-1",
            selectedServerIds: [],
            messages: [{ role: "user", content: "hello" }],
            model: {
              id: "openai/gpt-5-mini",
              provider: "openai",
              name: "GPT-5 Mini",
            },
          },
          rpcCollector: createHostedRpcLogCollector({}),
        });
        if (setup.response) return setup.response;
      }
      if (mode === "new-bearer")
        c.req.raw.headers.set("authorization", `Bearer ${replacementToken}`);
      if (mode === "revoked") revoked.markRevokedLocally(session);
      const bearer = await getBackgroundRunBearerForRequest(
        c,
        mode === "other-project" ? "project-2" : "project-1",
      );
      return c.json({ bearer: await bearer() });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        403,
      );
    }
  });
}
function request(target: Hono, mode: string) {
  return target.request(`/${mode}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}
function count(path: string) {
  return requests.filter((entry) => entry.path === path).length;
}
describe("managed setup to delegation over HTTP", () => {
  it("uses actual project authorization without a project-list request", async () => {
    const response = await request(app(), "same");
    expect(await response.json()).toEqual({ bearer: "fixture-delegation" });
    expect(count("/web/authorize-project")).toBe(1);
    expect(count("/api/query")).toBe(0);
    expect(
      requests.find((entry) => entry.path === "/web/delegated-token")
        ?.organization,
    ).toBe("authorized-org");
  });
  it.each(["other-project", "new-bearer"])(
    "looks up access for %s",
    async (mode) => {
      expect((await request(app(), mode)).status).toBe(200);
      expect(count("/api/query")).toBe(1);
      expect(
        requests.find((entry) => entry.path === "/api/query")?.authorization,
      ).toBe(`Bearer ${mode === "new-bearer" ? replacementToken : token}`);
      expect(
        requests.find((entry) => entry.path === "/web/delegated-token")
          ?.organization,
      ).toBe(mode === "other-project" ? "second-project-org" : "lookup-org");
    },
  );
  it("does not carry proof into another HTTP request", async () => {
    const target = app();
    expect((await request(target, "same")).status).toBe(200);
    expect((await request(target, "no-setup")).status).toBe(200);
    expect(count("/web/authorize-project")).toBe(1);
    expect(count("/api/query")).toBe(1);
  });
  it("rechecks revocation after setup before delegation", async () => {
    expect((await request(app(), "revoked")).status).toBe(403);
    expect(count("/web/authorize-project")).toBe(1);
    expect(count("/api/query")).toBe(0);
    expect(count("/web/delegated-token")).toBe(0);
  });
  it("keeps lookup when older authorization omits the role", async () => {
    legacyAuthorization = true;
    expect((await request(app(), "same")).status).toBe(200);
    expect(count("/api/query")).toBe(1);
    expect(
      requests.find((entry) => entry.path === "/web/delegated-token")
        ?.organization,
    ).toBe("lookup-org");
  });
});
