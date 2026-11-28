import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHostedOAuthUnauthorizedHandler } from "../hosted-oauth-refresh.js";
import {
  isUploadedAccount,
  uploadedAccountRecoveries,
  withUploadedAccountRecovery,
} from "../uploaded-account-recovery.js";
import { WebRouteError, ErrorCode } from "../../routes/web/errors.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

/** The 401 the server answered, carrying a sign-in challenge. */
function rejected() {
  return Object.assign(new Error("HTTP 401"), {
    statusCode: 401,
    authChallenge: {
      source: "http_401",
      facets: {
        challengeHeader: "bearer",
        hasResourceMetadata: false,
        hasScope: false,
        hasErrorParams: false,
      },
    },
  });
}

/** The refresh's answer for a token with no refresh token behind it. */
function noRefreshToken() {
  return new WebRouteError(401, ErrorCode.UNAUTHORIZED, "No refresh token.", {
    oauthRequired: true,
    refreshTokenUnavailable: true,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** The backend answering a re-resolve of `srv` for one account. */
function answer(result: Record<string, unknown>) {
  return { results: { srv: { ok: true as const, ...result } } };
}

function setup(reResolve = vi.fn(), targetOrigin?: string) {
  const recoveries = uploadedAccountRecoveries(reResolve);
  const manager = { disconnectServer: vi.fn(async () => undefined) };
  recoveries.bind(manager);
  const recovery = recoveries.for({
    account: { accountKind: "uploaded" },
    token: "old-token",
    connectionId: "acct_upload",
    serverId: "srv",
    serverName: "Linear",
    accountName: "CI account",
  });
  if (!recovery) throw new Error("expected a recovery");
  const refreshFails = vi.fn(async () => {
    throw noRefreshToken();
  });
  const handler = withUploadedAccountRecovery(
    refreshFails,
    recovery,
    targetOrigin,
  );
  return { reResolve, manager, handler, refreshFails, recovery };
}

describe("isUploadedAccount", () => {
  it("reads an account's own kind, a result's kind, or the kind of the account it lists", () => {
    expect(isUploadedAccount({ accountKind: "uploaded" })).toBe(true);
    expect(isUploadedAccount({ oauthAccountKind: "uploaded" })).toBe(true);
    expect(
      isUploadedAccount(
        {
          oauthConnections: [
            { connectionId: "a", accountKind: "shared" },
            { connectionId: "b", accountKind: "uploaded" },
          ],
        },
        "b",
      ),
    ).toBe(true);
    expect(
      isUploadedAccount(
        { oauthConnections: [{ connectionId: "b", accountKind: "uploaded" }] },
        "a",
      ),
    ).toBe(false);
    // A person's own sign-in, a shared account, and an older backend.
    expect(isUploadedAccount({})).toBe(false);
    expect(isUploadedAccount({ accountKind: "shared" })).toBe(false);
    expect(isUploadedAccount(undefined)).toBe(false);
  });

  it("reads the upload flag, which an upload on a shared server carries beside its kind", () => {
    expect(
      isUploadedAccount({
        oauthAccountKind: "shared",
        oauthAccountUploaded: true,
      }),
    ).toBe(true);
    expect(
      isUploadedAccount({ accountKind: "shared", accountUploaded: true }),
    ).toBe(true);
    expect(
      isUploadedAccount(
        {
          oauthAccountKind: "shared",
          oauthConnections: [
            { connectionId: "a", accountKind: "shared" },
            { connectionId: "b", accountKind: "shared", accountUploaded: true },
          ],
        },
        "b",
      ),
    ).toBe(true);
    expect(
      isUploadedAccount({ accountKind: "shared", accountUploaded: false }),
    ).toBe(false);
  });
});

describe("uploaded account recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves other accounts and an account with no id on the refresh alone", () => {
    const recoveries = uploadedAccountRecoveries(vi.fn());
    const base = { token: "t", serverId: "srv", serverName: "Linear" };
    expect(
      recoveries.for({ ...base, account: {}, connectionId: "acct" }),
    ).toBeUndefined();
    expect(
      recoveries.for({
        ...base,
        account: { accountKind: "uploaded" },
        connectionId: undefined,
      }),
    ).toBeUndefined();
    const handler = vi.fn();
    expect(withUploadedAccountRecovery(handler, undefined)).toBe(handler);
  });

  it("resolves the same account once after a failed refresh and retries with the newer token", async () => {
    const { reResolve, handler, refreshFails } = setup(
      vi.fn(async () =>
        answer({
          oauthAccessToken: "new-token",
          oauthCredentialId: "acct_upload",
        }),
      ),
    );

    await expect(
      handler({ serverId: "srv", error: rejected() }),
    ).resolves.toMatchObject({ accessToken: "new-token" });
    expect(refreshFails).toHaveBeenCalledTimes(1);
    expect(reResolve).toHaveBeenCalledTimes(1);
    expect(reResolve).toHaveBeenCalledWith("srv", "acct_upload");
  });

  it("never sends a newer token bound to another origin than the connection's", async () => {
    const moved = setup(
      vi.fn(async () =>
        answer({
          oauthAccessToken: "new-token",
          oauthCredentialId: "acct_upload",
          oauthBoundOrigins: ["https://b.example.com"],
        }),
      ),
      "https://a.example.com",
    );
    await expect(
      moved.handler({ serverId: "srv", error: rejected() }),
    ).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("now points at another address"),
      details: expect.objectContaining({ oauthRequired: true }),
    });
    // Stopped: a later rejection fails at once, with no second read.
    await expect(
      moved.handler({ serverId: "srv", error: rejected() }),
    ).rejects.toMatchObject({ status: 401 });
    expect(moved.reResolve).toHaveBeenCalledTimes(1);
    expect(moved.manager.disconnectServer).not.toHaveBeenCalled();

    const same = setup(
      vi.fn(async () =>
        answer({
          oauthAccessToken: "new-token",
          oauthCredentialId: "acct_upload",
          oauthBoundOrigins: ["https://a.example.com/mcp"],
        }),
      ),
      "https://a.example.com",
    );
    await expect(
      same.handler({ serverId: "srv", error: rejected() }),
    ).resolves.toMatchObject({ accessToken: "new-token" });
  });

  it("asks for a fresh upload when the token is unchanged, without offering a sign-in", async () => {
    const { reResolve, handler } = setup(
      vi.fn(async () => answer({ oauthAccessToken: "old-token" })),
    );
    const original = rejected();

    const failure = await handler({ serverId: "srv", error: original }).catch(
      (error: unknown) => error,
    );

    expect(failure).not.toBe(original);
    expect(failure).toMatchObject({
      status: 401,
      message:
        'Linear rejected the uploaded token for "CI account". Upload a fresh token for "CI account", then run again.',
      setupFailureSource: "oauth_refresh",
      details: { uploadedAccount: true, serverId: "srv" },
    });
    expect((failure as WebRouteError).details?.oauthRequired).toBeUndefined();
    expect(reResolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no token", {}],
    [
      "another account's token",
      { oauthAccessToken: "x", oauthCredentialId: "acct_other" },
    ],
  ])(
    "asks for a fresh upload when the answer has %s",
    async (_label, result) => {
      const { handler } = setup(vi.fn(async () => answer(result)));
      await expect(
        handler({ serverId: "srv", error: rejected() }),
      ).rejects.toThrow('Upload a fresh token for "CI account"');
    },
  );

  it("compares against a token a refresh already put in place", async () => {
    const reResolve = vi.fn(async () =>
      answer({ oauthAccessToken: "refreshed" }),
    );
    const recovery = uploadedAccountRecoveries(reResolve).for({
      account: { accountKind: "uploaded" },
      token: "old-token",
      connectionId: "acct_upload",
      serverId: "srv",
      serverName: "Linear",
    });
    if (!recovery) throw new Error("expected a recovery");
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: "refreshed" })
      .mockRejectedValueOnce(noRefreshToken());
    const handler = withUploadedAccountRecovery(refresh, recovery);

    await expect(
      handler({ serverId: "srv", error: rejected() }),
    ).resolves.toMatchObject({
      accessToken: "refreshed",
    });
    expect(reResolve).not.toHaveBeenCalled();
    await expect(
      handler({ serverId: "srv", error: rejected() }),
    ).rejects.toThrow(
      "Linear rejected its uploaded token. Upload a fresh token for Linear, then run again.",
    );
  });

  it.each([
    [
      "refuses the member",
      async () => ({
        results: {
          srv: {
            ok: false as const,
            status: 403,
            code: "FORBIDDEN",
            message: "Not a member of this project",
          },
        },
      }),
      "Not a member of this project",
    ],
    [
      "withdraws local runs",
      async () =>
        answer({
          oauthUnavailableReason: "credential_export_denied",
          oauthUnavailablePolicy: "hostedOnlyAccount",
          oauthUnavailableMessage: "Ask a project admin to allow local runs.",
        }),
      "Ask a project admin to allow local runs.",
    ],
    [
      "answers 404 for the server",
      async () => {
        throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Server not found");
      },
      "Server not found",
    ],
  ])(
    "disconnects when the backend %s, and asks no more",
    async (_label, resolve, message) => {
      const { reResolve, handler, manager, refreshFails } = setup(
        vi.fn(resolve),
      );

      await expect(
        handler({ serverId: "srv#acct", error: rejected() }),
      ).rejects.toThrow(message);
      // After the refused exchange has failed, not during it.
      expect(manager.disconnectServer).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(manager.disconnectServer).toHaveBeenCalledWith("srv#acct");

      await expect(
        handler({ serverId: "srv#acct", error: rejected() }),
      ).rejects.toThrow(message);
      expect(reResolve).toHaveBeenCalledTimes(1);
      // Answered before any refresh is spent on it.
      expect(refreshFails).toHaveBeenCalledTimes(1);
    },
  );

  it("does not disconnect when the backend could not be reached", async () => {
    const { handler, manager } = setup(
      vi.fn(async () => {
        throw new WebRouteError(
          502,
          ErrorCode.SERVER_UNREACHABLE,
          "unreachable",
        );
      }),
    );

    await expect(
      handler({ serverId: "srv", error: rejected() }),
    ).rejects.toThrow("unreachable");
    await vi.runAllTimersAsync();
    expect(manager.disconnectServer).not.toHaveBeenCalled();
  });

  it("reads once: after asking for a fresh upload, later rejections fail at once with no refresh or read", async () => {
    const { reResolve, handler, refreshFails } = setup(
      vi.fn(async () => answer({ oauthAccessToken: "old-token" })),
    );

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        handler({ serverId: "srv", error: rejected() }),
      ).rejects.toMatchObject({
        status: 401,
        setupFailureSource: "oauth_refresh",
        message:
          'Linear rejected the uploaded token for "CI account". Upload a fresh token for "CI account", then run again.',
      });
    }
    expect(refreshFails).toHaveBeenCalledTimes(1);
    expect(reResolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "another refresh holds the lease",
      new WebRouteError(409, "refresh_in_progress" as ErrorCode, "Busy."),
    ],
    [
      "the refresh budget is spent",
      new WebRouteError(429, ErrorCode.RATE_LIMITED, "Too many refreshes."),
    ],
    [
      "the authorization server is down",
      new WebRouteError(
        503,
        "authorization_server_unreachable" as ErrorCode,
        "Unreachable.",
      ),
    ],
    ["the network failed", new Error("socket hang up")],
  ])(
    "keeps the refresh's own error when %s, and still refreshes next time",
    async (_label, failure) => {
      const reResolve = vi.fn();
      const recovery = uploadedAccountRecoveries(reResolve).for({
        account: { accountKind: "uploaded" },
        token: "old-token",
        connectionId: "acct_upload",
        serverId: "srv",
        serverName: "Linear",
      });
      const refresh = vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ accessToken: "renewed" });
      const handler = withUploadedAccountRecovery(refresh, recovery);

      await expect(
        handler({ serverId: "srv", error: rejected() }),
      ).rejects.toBe(failure);
      await expect(
        handler({ serverId: "srv", error: rejected() }),
      ).resolves.toMatchObject({ accessToken: "renewed" });
      expect(reResolve).not.toHaveBeenCalled();
    },
  );

  it("gives simultaneous rejections of one token a single read", async () => {
    const read = deferred<ReturnType<typeof answer>>();
    const { reResolve, handler } = setup(vi.fn(() => read.promise));

    const both = Promise.all([
      handler({ serverId: "srv", error: rejected() }),
      handler({ serverId: "srv", error: rejected() }),
    ]);
    await vi.waitFor(() => expect(reResolve).toHaveBeenCalledTimes(1));
    read.resolve(answer({ oauthAccessToken: "new-token" }));

    await expect(both).resolves.toMatchObject([
      { accessToken: "new-token" },
      { accessToken: "new-token" },
    ]);
    expect(reResolve).toHaveBeenCalledTimes(1);
  });

  it("hands a late rejection of the old token the newer one another exchange put in place", async () => {
    const slowRefresh = deferred<void>();
    const reResolve = vi.fn(async () =>
      answer({ oauthAccessToken: "new-token" }),
    );
    const recovery = uploadedAccountRecoveries(reResolve).for({
      account: { accountKind: "uploaded" },
      token: "old-token",
      connectionId: "acct_upload",
      serverId: "srv",
      serverName: "Linear",
    });
    const refresh = vi
      .fn()
      .mockImplementationOnce(async () => {
        await slowRefresh.promise;
        throw noRefreshToken();
      })
      .mockRejectedValueOnce(noRefreshToken());
    const handler = withUploadedAccountRecovery(refresh, recovery);

    const late = handler({ serverId: "srv", error: rejected() });
    await expect(
      handler({ serverId: "srv", error: rejected() }),
    ).resolves.toMatchObject({ accessToken: "new-token" });
    slowRefresh.resolve();

    await expect(late).resolves.toMatchObject({ accessToken: "new-token" });
    expect(reResolve).toHaveBeenCalledTimes(1);
  });

  it("compares the read with the token the rejected exchange sent, not one a refresh put in place since", async () => {
    const read = deferred<ReturnType<typeof answer>>();
    const recovery = uploadedAccountRecoveries(vi.fn(() => read.promise)).for({
      account: { accountKind: "uploaded" },
      token: "old-token",
      connectionId: "acct_upload",
      serverId: "srv",
      serverName: "Linear",
    });
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(noRefreshToken())
      .mockResolvedValueOnce({ accessToken: "refreshed" });
    const handler = withUploadedAccountRecovery(refresh, recovery);

    const reading = handler({ serverId: "srv", error: rejected() });
    await expect(
      handler({ serverId: "srv", error: rejected() }),
    ).resolves.toMatchObject({ accessToken: "refreshed" });
    read.resolve(answer({ oauthAccessToken: "refreshed" }));

    await expect(reading).resolves.toMatchObject({ accessToken: "refreshed" });
  });
});

describe("buildHostedOAuthUnauthorizedHandler with an uploaded account", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    vi.unstubAllGlobals();
  });

  it.each([
    [
      "an upload on a shared server",
      { oauthAccountKind: "shared", oauthAccountUploaded: true },
    ],
    ["an older backend's upload", { oauthAccountKind: "uploaded" }],
  ])(
    "re-reads %s when the backend has no refresh token, instead of handing back the sign-in challenge",
    async (_label, account) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "refresh_token_unavailable" }), {
            status: 401,
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const reResolve = vi.fn(async () =>
        answer({ oauthAccessToken: "new-token" }),
      );
      const handler = buildHostedOAuthUnauthorizedHandler({
        bearerToken: "token",
        projectId: "project-1",
        serverId: "srv",
        serverName: "Linear",
        uploaded: uploadedAccountRecoveries(reResolve).for({
          account,
          token: "old-token",
          connectionId: "acct_upload",
          serverId: "srv",
          serverName: "Linear",
        }),
      });

      await expect(
        handler({ serverId: "srv", error: rejected() }),
      ).resolves.toMatchObject({
        accessToken: "new-token",
      });
      // One refresh, one re-resolve.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(reResolve).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      409,
      { code: "refresh_in_progress", message: "Another refresh is running." },
    ],
    [429, { code: "RATE_LIMITED", message: "Too many refreshes." }],
    [503, { code: "authorization_server_unreachable", message: "No answer." }],
  ])(
    "keeps the backend's %i instead of asking for an upload",
    async (status, body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(body), { status })),
      );
      const reResolve = vi.fn();
      const handler = buildHostedOAuthUnauthorizedHandler({
        bearerToken: "token",
        projectId: "project-1",
        serverId: "srv",
        serverName: "Linear",
        uploaded: uploadedAccountRecoveries(reResolve).for({
          account: { oauthAccountKind: "shared", oauthAccountUploaded: true },
          token: "old-token",
          connectionId: "acct_upload",
          serverId: "srv",
          serverName: "Linear",
        }),
      });

      await expect(
        handler({ serverId: "srv", error: rejected() }),
      ).rejects.toMatchObject({ status, message: body.message });
      expect(reResolve).not.toHaveBeenCalled();
    },
  );
});

it("reports a rejected replacement without reading another credential", async () => {
  const { handler, reResolve } = setup(vi.fn().mockResolvedValue(answer({ oauthAccessToken: "new-token" })));
  const result = await handler({ serverId: "srv", error: rejected() });
  expect(() => result.onRetryRejected?.(rejected())).toThrow('Upload a fresh token');
  expect(reResolve).toHaveBeenCalledTimes(1);
});
