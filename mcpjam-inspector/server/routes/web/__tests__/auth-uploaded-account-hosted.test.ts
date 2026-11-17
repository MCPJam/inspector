import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnauthorizedRefreshHandler } from "@mcpjam/sdk";

type RecordedConfig = { onUnauthorized?: UnauthorizedRefreshHandler };

const managers = vi.hoisted(
  () => [] as Array<{ configs: Record<string, RecordedConfig> }>,
);

// Hosted chat, v1 and scheduled runs build their managers here too.
vi.mock("../../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config.js")>()),
  HOSTED_MODE: true,
}));

vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  class RecordingManager {
    configs: Record<string, RecordedConfig>;
    disconnectServer = vi.fn(async () => undefined);
    disconnectAllServers = vi.fn(async () => undefined);
    constructor(configs: Record<string, RecordedConfig>) {
      this.configs = configs;
      managers.push(this);
    }
  }
  return { ...actual, MCPClientManager: RecordingManager };
});

import { createAuthorizedManager } from "../auth.js";

const CONVEX = "https://convex.test";

let forceRefresh: () => Response;
let requests: Array<{ route: string; body: Record<string, any> }>;

/** An upload on a shared server, as the hosted authorize answer reports it. */
function uploadOnSharedServer(token: string) {
  return Response.json({
    results: {
      srv_1: {
        ok: true,
        role: "member",
        accessLevel: "project_member",
        permissions: { chatOnly: false },
        serverConfig: {
          transportType: "http",
          url: "https://mcp.linear.example/mcp",
          useOAuth: true,
          name: "Linear",
        },
        oauthAccessToken: token,
        oauthCredentialId: "acct_upload",
        oauthAccountKind: "shared",
        oauthAccountUploaded: true,
      },
    },
  });
}

async function onUnauthorized() {
  await createAuthorizedManager({}, "bearer", "project-1", ["srv_1"], 10_000);
  const handler = managers[0]?.configs.srv_1?.onUnauthorized;
  if (!handler) throw new Error("No 401 handler for srv_1");
  return handler;
}

const rejected = () =>
  Object.assign(new Error("HTTP 401"), { statusCode: 401 });

describe("createAuthorizedManager in hosted mode with an uploaded account", () => {
  beforeEach(() => {
    managers.length = 0;
    requests = [];
    vi.stubEnv("CONVEX_HTTP_URL", CONVEX);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const route = String(input).slice(CONVEX.length);
        const body = JSON.parse(String(init?.body));
        requests.push({ route, body });
        if (route === "/web/oauth/force-refresh") return forceRefresh();
        if (route !== "/web/authorize-batch") {
          throw new Error(`Unexpected fetch ${route}`);
        }
        // The re-read names the connection; the first authorize does not.
        return uploadOnSharedServer(
          body.connectionIds ? "new-token" : "old-token",
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("re-reads the upload through the hosted authorize when the refresh has no token", async () => {
    forceRefresh = () =>
      Response.json({ code: "refresh_token_unavailable" }, { status: 401 });
    const handler = await onUnauthorized();

    await expect(
      handler({ serverId: "srv_1", error: rejected() }),
    ).resolves.toEqual({
      accessToken: "new-token",
      onRetryRejected: expect.any(Function),
    });
    expect(requests.map((r) => r.route)).toEqual([
      "/web/authorize-batch",
      "/web/oauth/force-refresh",
      "/web/authorize-batch",
    ]);
    expect(requests[2]?.body).toMatchObject({
      projectId: "project-1",
      serverIds: ["srv_1"],
      connectionIds: { srv_1: "acct_upload" },
    });
  });

  it("keeps a refresh that is already running as its own error, without a re-read", async () => {
    forceRefresh = () =>
      Response.json(
        { code: "refresh_in_progress", message: "Another refresh is running." },
        { status: 409 },
      );
    const handler = await onUnauthorized();

    await expect(
      handler({ serverId: "srv_1", error: rejected() }),
    ).rejects.toMatchObject({
      status: 409,
      code: "refresh_in_progress",
      message: "Another refresh is running.",
    });
    expect(requests.map((r) => r.route)).toEqual([
      "/web/authorize-batch",
      "/web/oauth/force-refresh",
    ]);
  });
});
