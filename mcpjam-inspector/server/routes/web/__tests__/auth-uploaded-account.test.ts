import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnauthorizedRefreshHandler } from "@mcpjam/sdk";

type RecordedConfig = { onUnauthorized?: UnauthorizedRefreshHandler };

const managers = vi.hoisted(
  () =>
    [] as Array<{
      configs: Record<string, RecordedConfig>;
      disconnectServer: ReturnType<typeof vi.fn>;
    }>,
);

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

/** What the backend answered, by route, and every request it got. */
let answers: Record<string, () => Response>;
let requests: Array<{ route: string; body: Record<string, any> }>;

function serverResult(extra: Record<string, unknown>) {
  return {
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
    ...extra,
  };
}

function rejected() {
  return Object.assign(new Error("HTTP 401"), { statusCode: 401 });
}

function onUnauthorized(key = "srv_1") {
  const handler = managers[0]?.configs[key]?.onUnauthorized;
  if (!handler) throw new Error(`No 401 handler for ${key}`);
  return handler;
}

describe("createAuthorizedManager with an uploaded account", () => {
  beforeEach(() => {
    managers.length = 0;
    requests = [];
    vi.stubEnv("CONVEX_HTTP_URL", CONVEX);
    answers = {
      // No refresh token: the upload carried none.
      "/web/oauth/force-refresh": () =>
        new Response(JSON.stringify({ code: "refresh_token_unavailable" }), {
          status: 401,
        }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const route = String(input).slice(CONVEX.length);
        requests.push({ route, body: JSON.parse(String(init?.body)) });
        const respond = answers[route];
        if (!respond) throw new Error(`Unexpected fetch ${route}`);
        return respond();
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    [
      "on a shared server",
      { oauthAccountKind: "shared", oauthAccountUploaded: true },
    ],
    ["from an older backend", { oauthAccountKind: "uploaded" }],
  ])(
    "re-reads an uploaded default account %s that a multi-account manager groups",
    async (_label, kind) => {
      answers["/web/authorize-batch"] = () =>
        Response.json({
          results: {
            srv_1: serverResult({
              oauthAccessToken: "old-token",
              oauthCredentialId: "acct_upload",
              ...kind,
            }),
          },
        });
      answers["/web/authorize-batch-local"] = () =>
        Response.json({
          results: {
            srv_1: serverResult({
              oauthAccessToken: "new-token",
              oauthCredentialId: "acct_upload",
            }),
          },
        });
      await createAuthorizedManager(
        {},
        "bearer",
        "project-1",
        ["srv_1"],
        10_000,
        undefined,
        undefined,
        { multiConnection: true },
      );
      const key = Object.keys(managers[0]!.configs)[0]!;

      await expect(
        onUnauthorized(key)({ serverId: key, error: rejected() }),
      ).resolves.toEqual({
        accessToken: "new-token",
        onRetryRejected: expect.any(Function),
      });
    },
  );

  it("re-reads a chosen uploaded account by its id, once, and retries with the newer token", async () => {
    answers["/web/authorize-batch"] = () =>
      Response.json({
        results: {
          srv_1: serverResult({
            oauthAccountSet: "applied",
            oauthAccessToken: "old-token",
            oauthCredentialId: "acct_upload",
            oauthConnections: [
              {
                connectionId: "acct_upload",
                isDefault: true,
                displayName: "CI account",
                accessToken: "old-token",
                accountKind: "uploaded",
              },
            ],
          }),
        },
      });
    answers["/web/authorize-batch-local"] = () =>
      Response.json({
        results: {
          srv_1: serverResult({
            oauthAccessToken: "new-token",
            oauthCredentialId: "acct_upload",
          }),
        },
      });
    await createAuthorizedManager(
      {},
      "bearer",
      "project-1",
      ["srv_1"],
      10_000,
      undefined,
      undefined,
      {
        connectionIdSets: { srv_1: ["acct_upload"] },
      },
    );

    await expect(
      onUnauthorized()({ serverId: "srv_1", error: rejected() }),
    ).resolves.toEqual({
      accessToken: "new-token",
      onRetryRejected: expect.any(Function),
    });
    const reResolves = requests.filter(
      (r) => r.route === "/web/authorize-batch-local",
    );
    expect(reResolves).toEqual([
      {
        route: "/web/authorize-batch-local",
        body: {
          projectId: "project-1",
          serverIds: ["srv_1"],
          connectionIds: { srv_1: "acct_upload" },
        },
      },
    ]);
  });

  it("disconnects a default uploaded account when the backend refuses it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    answers["/web/authorize-batch"] = () =>
      Response.json({
        results: {
          srv_1: serverResult({
            oauthAccessToken: "old-token",
            oauthCredentialId: "acct_upload",
            oauthAccountKind: "uploaded",
          }),
        },
      });
    answers["/web/authorize-batch-local"] = () =>
      Response.json({
        results: {
          srv_1: serverResult({
            oauthUnavailableReason: "credential_export_denied",
            oauthUnavailablePolicy: "credentialExportPolicy",
          }),
        },
      });
    await createAuthorizedManager({}, "bearer", "project-1", ["srv_1"], 10_000);

    await expect(
      onUnauthorized()({ serverId: "srv_1", error: rejected() }),
    ).rejects.toMatchObject({
      status: 403,
      details: { exportDenied: true, policy: "credentialExportPolicy" },
    });
    await vi.runAllTimersAsync();
    expect(managers[0].disconnectServer).toHaveBeenCalledWith("srv_1");
  });

  it("re-reads a test user uploaded to a shared server, which reports the account as shared", async () => {
    answers["/web/authorize-batch"] = () =>
      Response.json({
        results: {
          srv_1: serverResult({
            oauthAccessToken: "old-token",
            oauthCredentialId: "acct_upload",
            oauthAccountKind: "shared",
            oauthAccountUploaded: true,
          }),
        },
      });
    answers["/web/authorize-batch-local"] = () =>
      Response.json({
        results: {
          srv_1: serverResult({
            oauthAccessToken: "new-token",
            oauthCredentialId: "acct_upload",
            oauthAccountKind: "shared",
            oauthAccountUploaded: true,
          }),
        },
      });
    await createAuthorizedManager({}, "bearer", "project-1", ["srv_1"], 10_000);

    await expect(
      onUnauthorized()({
        serverId: "srv_1",
        error: Object.assign(rejected(), {
          authChallenge: {
            source: "http_401",
            facets: {
              challengeHeader: "bearer",
              hasResourceMetadata: false,
              hasScope: false,
              hasErrorParams: false,
            },
          },
        }),
      }),
    ).resolves.toEqual({
      accessToken: "new-token",
      onRetryRejected: expect.any(Function),
    });
    expect(requests.map((r) => r.route)).toEqual([
      "/web/authorize-batch",
      "/web/oauth/force-refresh",
      "/web/authorize-batch-local",
    ]);
  });

  it("asks a chosen upload on a shared server for a fresh token once, then fails its later rejections at once", async () => {
    answers["/web/authorize-batch"] = () =>
      Response.json({
        results: {
          srv_1: serverResult({
            oauthAccountSet: "applied",
            oauthAccessToken: "old-token",
            oauthCredentialId: "acct_upload",
            oauthAccountKind: "shared",
            oauthConnections: [
              {
                connectionId: "acct_upload",
                isDefault: true,
                displayName: "CI account",
                accessToken: "old-token",
                accountKind: "shared",
                accountUploaded: true,
              },
            ],
          }),
        },
      });
    answers["/web/authorize-batch-local"] = () =>
      Response.json({
        results: {
          srv_1: serverResult({
            oauthAccessToken: "old-token",
            oauthCredentialId: "acct_upload",
          }),
        },
      });
    await createAuthorizedManager(
      {},
      "bearer",
      "project-1",
      ["srv_1"],
      10_000,
      undefined,
      undefined,
      { connectionIdSets: { srv_1: ["acct_upload"] } },
    );

    for (let call = 0; call < 3; call++) {
      await expect(
        onUnauthorized()({ serverId: "srv_1", error: rejected() }),
      ).rejects.toThrow(
        'Linear rejected the uploaded token for "CI account". Upload a fresh token for "CI account", then run again.',
      );
    }
    expect(requests.map((r) => r.route)).toEqual([
      "/web/authorize-batch",
      "/web/oauth/force-refresh",
      "/web/authorize-batch-local",
    ]);
  });

  it("lets two managers on one uploaded account each read the upload for itself", async () => {
    answers["/web/authorize-batch"] = () =>
      Response.json({
        results: {
          srv_1: serverResult({
            oauthAccessToken: "old-token",
            oauthCredentialId: "acct_upload",
            oauthAccountKind: "shared",
            oauthAccountUploaded: true,
          }),
        },
      });
    let upload = "new-token";
    answers["/web/authorize-batch-local"] = () =>
      Response.json({
        results: {
          srv_1: serverResult({
            oauthAccessToken: upload,
            oauthCredentialId: "acct_upload",
          }),
        },
      });
    await createAuthorizedManager({}, "bearer", "project-1", ["srv_1"], 10_000);
    await createAuthorizedManager({}, "bearer", "project-1", ["srv_1"], 10_000);
    const [first, second] = managers.map(
      (manager) => manager.configs.srv_1!.onUnauthorized!,
    );
    const reads = () =>
      requests.filter((r) => r.route === "/web/authorize-batch-local").length;

    // The first run finds the newer upload; the second, still on the old
    // token, finds it too with a read of its own.
    await expect(
      first!({ serverId: "srv_1", error: rejected() }),
    ).resolves.toEqual({
      accessToken: "new-token",
      onRetryRejected: expect.any(Function),
    });
    await expect(
      second!({ serverId: "srv_1", error: rejected() }),
    ).resolves.toEqual({
      accessToken: "new-token",
      onRetryRejected: expect.any(Function),
    });
    expect(reads()).toBe(2);

    // The first run gives up on a rejected upload; the second still reads
    // the one uploaded after that.
    await expect(
      first!({ serverId: "srv_1", error: rejected() }),
    ).rejects.toThrow("Upload a fresh token for Linear");
    upload = "fresh-token";
    await expect(
      second!({ serverId: "srv_1", error: rejected() }),
    ).resolves.toEqual({
      accessToken: "fresh-token",
      onRetryRejected: expect.any(Function),
    });
    await expect(
      first!({ serverId: "srv_1", error: rejected() }),
    ).rejects.toThrow("Upload a fresh token for Linear");
    expect(reads()).toBe(4);
  });

  it("leaves a person's own sign-in on the refresh alone", async () => {
    answers["/web/authorize-batch"] = () =>
      Response.json({
        results: {
          srv_1: serverResult({
            oauthAccessToken: "old-token",
            oauthCredentialId: "acct_own",
          }),
        },
      });
    await createAuthorizedManager({}, "bearer", "project-1", ["srv_1"], 10_000);

    await expect(
      onUnauthorized()({ serverId: "srv_1", error: rejected() }),
    ).rejects.toMatchObject({ details: { refreshTokenUnavailable: true } });
    expect(requests.map((r) => r.route)).toEqual([
      "/web/authorize-batch",
      "/web/oauth/force-refresh",
    ]);
  });
});
