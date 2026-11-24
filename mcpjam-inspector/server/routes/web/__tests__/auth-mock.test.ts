/**
 * A mock's authorize entry through the connection builder, in the local build
 * and the hosted one: the dialer gets an in-process config built from the
 * marker, carries the grant and its own auth context into the route, asks
 * authorize for the pin again when it re-mints, and leaves every other server
 * with the config it had.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerConfig } from "@mcpjam/sdk";

const { hosted } = vi.hoisted(() => ({ hosted: { on: false } }));

vi.mock("../../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return hosted.on;
    },
  };
});
vi.mock("../../../utils/mcp-backpressure.js", () => ({
  hostedMcpBackpressureFetch: ({ fetch }: { fetch: typeof globalThis.fetch }) => fetch,
}));

import { scrubDeliveredSecrets } from "../../../../shared/delivered-secret-registry.js";
import { registerMockInProcessHandler } from "../../../services/mock/registry.js";
import { createAuthorizedManager } from "../auth.js";
import { bindMockRun } from "../../../utils/mock-run.js";
import {
  createInputAnswerResolver,
  inputAnswerResolverOf,
} from "../../../services/evals/input-answers.js";

const NOW = 1_800_000_000_000;
const GRANT = "grant-token-aaaaaaaaaaaa";
const REGRANT = "grant-token-bbbbbbbbbbbb";

let authorizeBodies: Array<Record<string, unknown>>;
let grants: string[];
/** How long the first grant minted lasts; later ones last an hour. */
let firstLife: number;
let lastManager: object;

function authorizeAnswer(grant: string, life: number) {
  return Response.json({
    organizationId: "org1",
    results: {
      mock1: {
        ok: true,
        role: "member",
        accessLevel: "project_member",
        permissions: { chatOnly: false },
        oauthAccessToken: grant,
        serverConfig: {
          name: "Echo mock",
          transportType: "http",
          url: "https://mock.mcpjam.invalid/mock1",
          headers: {},
          mock: { mockId: "mock1", version: 7, contentHash: "h".repeat(64), grantExpiresAt: NOW + life },
        },
      },
      plain: {
        ok: true,
        role: "member",
        accessLevel: "project_member",
        permissions: { chatOnly: false },
        serverConfig: {
          name: "Plain",
          transportType: "http",
          url: "https://plain.example/mcp",
          headers: {},
        },
      },
    },
  });
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  authorizeBodies = [];
  grants = [];
  firstLife = 3_600_000;
  let minted = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      authorizeBodies.push(JSON.parse(String(init.body)));
      minted += 1;
      return authorizeAnswer(minted === 1 ? GRANT : REGRANT, minted === 1 ? firstLife : 3_600_000);
    }),
  );
  registerMockInProcessHandler(async (_id, _request, door) => {
    grants.push(door.grant);
    return new Response("{}", { status: 200 });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

for (const mode of ["local", "hosted"] as const) {
  describe(`the connection builder, ${mode} build`, () => {
    beforeEach(() => {
      hosted.on = mode === "hosted";
    });

    async function open(extra: { mockRunKey?: string } = {}) {
      const result = await createAuthorizedManager(
        { authMethod: "authkit_jwt", workosUserId: "ann", mcpjamOrganizationId: "org1" },
        "ann-bearer",
        "proj1",
        ["mock1", "plain"],
        9_000,
        undefined,
        { roots: {} },
        { lazyConnect: true, mockVersions: { mock1: 5 }, ...extra },
      );
      lastManager = result.manager;
      return result.authorizedServerConfigs as Record<string, MCPServerConfig & { url: string }>;
    }

    it("dials the mock in process from its marker, as the person who connected", async () => {
      const configs = await open();
      const config = configs.mock1;
      expect(config.credentialSource).toBe("mcpjam-backend");
      expect(config.url).toBe("https://mock.mcpjam.invalid/mock1");
      const doors: unknown[] = [];
      registerMockInProcessHandler(async (_id, _request, door) => {
        doors.push(door);
        return new Response("{}");
      });
      await config.baseFetch!(config.url, { method: "POST", body: "{}" });
      expect(doors).toEqual([
        expect.objectContaining({
          grant: GRANT,
          bearerToken: "ann-bearer",
          projectId: "proj1",
          caller: expect.objectContaining({ authMethod: "authkit_jwt", workosUserId: "ann" }),
          profile: expect.objectContaining({ timeoutMs: 9_000, clientCapabilities: { roots: {} } }),
        }),
      ]);
    });

    it("names the eval run once it has an id, on a connection built before it", async () => {
      const configs = await open();
      const doors: Array<{ runKey?: string }> = [];
      registerMockInProcessHandler(async (_id, _request, door) => {
        doors.push(door);
        return new Response("{}");
      });
      await configs.mock1.baseFetch!(configs.mock1.url, { method: "POST", body: "{}" });
      bindMockRun(lastManager, "run-9");
      await configs.mock1.baseFetch!(configs.mock1.url, { method: "POST", body: "{}" });
      expect(doors.map((door) => door.runKey)).toEqual([undefined, "run-9"]);
    });

    it("keeps the run a dialer named when it connected, as the harness proxy does", async () => {
      const configs = await open({ mockRunKey: "token-run" });
      const doors: Array<{ runKey?: string }> = [];
      registerMockInProcessHandler(async (_id, _request, door) => {
        doors.push(door);
        return new Response("{}");
      });
      bindMockRun(lastManager, "run-9");
      await configs.mock1.baseFetch!(configs.mock1.url, { method: "POST", body: "{}" });
      expect(doors[0]?.runKey).toBe("token-run");
    });

    it("registers an eval's replies with the connection, and names each server for them", async () => {
      const resolver = createInputAnswerResolver({
        answers: [{ server: "Echo mock", action: "accept" }],
      });
      const { manager } = await createAuthorizedManager(
        { authMethod: "authkit_jwt", workosUserId: "ann", mcpjamOrganizationId: "org1" },
        "ann-bearer",
        "proj1",
        ["mock1", "plain"],
        9_000,
        undefined,
        undefined,
        { lazyConnect: true, mockVersions: { mock1: 5 }, inputAnswers: resolver },
      );
      // Registered before the first await past the manager's construction, so
      // the capability is declared at connect.
      expect(inputAnswerResolverOf(manager)).toBe(resolver);
      const reply = await resolver.elicitationCallback({
        requestId: "r",
        message: "Anything?",
        schema: {},
        serverId: "mock1",
      });
      expect(reply).toEqual({ action: "accept" });
      expect(resolver.exchanges[0]).toMatchObject({ server: "Echo mock", replyIndex: 0 });
    });

    it("asks authorize for the caller's pin, and again for the same pin when it re-mints", async () => {
      firstLife = 20_000;
      const configs = await open();
      expect(authorizeBodies[0]).toMatchObject({ serverIds: ["mock1", "plain"], mockVersions: { mock1: 5 } });
      // 20 s left is inside the 30 s renewal margin: the first call mints again.
      await configs.mock1.baseFetch!(configs.mock1.url, { method: "POST", body: "{}" });
      expect(authorizeBodies).toHaveLength(2);
      expect(authorizeBodies[1]).toMatchObject({ serverIds: ["mock1"], mockVersions: { mock1: 5 } });
      expect(grants).toEqual([REGRANT]);
    });

    it("keeps both grants out of anything that is logged", async () => {
      firstLife = 20_000;
      const configs = await open();
      await configs.mock1.baseFetch!(configs.mock1.url, { method: "POST", body: "{}" });
      expect(scrubDeliveredSecrets(`${GRANT} ${REGRANT}`)).not.toMatch(/grant-token/);
    });

    it("leaves every other server with the config it had", async () => {
      const { plain } = await open();
      expect(plain.url).toBe("https://plain.example/mcp");
      expect(plain.credentialSource).toBeUndefined();
      const handled: string[] = [];
      registerMockInProcessHandler(async (id) => {
        handled.push(id);
        return new Response("{}");
      });
      // Not routed in process: its fetch is the guarded network one.
      await plain.baseFetch!(plain.url, { method: "POST", body: "{}" }).catch(() => undefined);
      expect(handled).toEqual([]);
    });
  });
}
