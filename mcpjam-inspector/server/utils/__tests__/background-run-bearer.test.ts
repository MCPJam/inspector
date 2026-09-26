import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Context } from "hono";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  query: vi.fn(),
  setAuth: vi.fn(),
}));
vi.mock("../../services/authkit-jwt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/authkit-jwt.js")>()),
  verifyAuthKitToken: mocks.verify,
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth = mocks.setAuth;
    query = mocks.query;
  },
}));

import { AuthKitVerificationError } from "../../services/authkit-jwt.js";
import { getBackgroundRunBearerForRequest } from "../v1-convex-token.js";
import {
  RevokedSessionCache,
  setRevokedSessionCacheForTests,
} from "../../services/revoked-session-cache.js";

const mint = vi.fn();
let userNumber = 0;
let subject: string;

async function authorize(seed?: (c: Context) => void) {
  let getBearer: (() => Promise<string>) | undefined;
  let error: unknown;
  const app = new Hono();
  app.get("/", async (c) => {
    seed?.(c);
    try {
      getBearer = await getBackgroundRunBearerForRequest(c, "project-1");
    } catch (cause) {
      error = cause;
    }
    return c.json({ ok: !error });
  });
  await app.request("/", {
    headers: { Authorization: "Bearer browser-token" },
  });
  return { getBearer, error };
}

beforeEach(() => {
  vi.clearAllMocks();
  subject = `user-background-${++userNumber}`;
  mocks.verify.mockResolvedValue({
    sub: subject,
    orgId: "unrelated-active-org",
  });
  mocks.query.mockResolvedValue([
    { _id: "project-1", organizationId: "project-org" },
  ]);
  mint.mockImplementation(async () =>
    Response.json({
      ok: true,
      token: `execution-token-${mint.mock.calls.length}`,
      expiresAt: Date.now() + 2 * 60 * 60 * 1000,
    }),
  );
  vi.stubGlobal("fetch", mint);
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
  vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
});
afterEach(() => {
  setRevokedSessionCacheForTests(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("browser authorization for detached runs", () => {
  it("uses the verified user and authorized project's organization, then renews without the browser", async () => {
    vi.useFakeTimers();
    const { getBearer, error } = await authorize((c) => {
      c.set("workosUserId", "untrusted-context-user");
      c.set("mcpjamOrganizationId", "untrusted-context-org");
    });
    expect(error).toBeUndefined();
    expect(mocks.verify).toHaveBeenCalledWith("browser-token");
    expect(mocks.setAuth).toHaveBeenCalledWith("browser-token");
    expect(mint.mock.calls[0][1].headers).toMatchObject({
      "x-mcpjam-acting-as": subject,
      "x-mcpjam-acting-in-org": "project-org",
    });
    expect(await getBearer!()).toBe("execution-token-1");
    expect(mint).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 111 * 60 * 1000);
    expect(await getBearer!()).toBe("execution-token-2");
    expect(mint).toHaveBeenCalledTimes(2);
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid browser token before project lookup or delegation", async () => {
    mocks.verify.mockRejectedValueOnce(
      new AuthKitVerificationError("bad signature"),
    );
    const { error, getBearer } = await authorize();
    expect(error).toMatchObject({ status: 401 });
    expect(getBearer).toBeUndefined();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });

  it("refuses a revoked session before project lookup or delegation", async () => {
    const list = new RevokedSessionCache({
      fetchPage: () => new Promise(() => {}),
    });
    list.markRevokedLocally("session-revoked");
    setRevokedSessionCacheForTests(list);
    mocks.verify.mockResolvedValueOnce({
      sub: subject,
      sid: "session-revoked",
    });

    const { error, getBearer } = await authorize();

    expect(error).toMatchObject({ status: 401, code: "SESSION_REVOKED" });
    expect(getBearer).toBeUndefined();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });

  it("leaves the session check to Convex while the revoked-session list is loading", async () => {
    // The project lookup runs under the caller's own bearer, and Convex checks
    // the session itself, so an incomplete list is no reason to refuse here.
    setRevokedSessionCacheForTests(
      new RevokedSessionCache({ fetchPage: () => new Promise(() => {}) }),
    );
    mocks.verify.mockResolvedValueOnce({ sub: subject, sid: "session-live" });

    const { error } = await authorize();

    expect(error).toBeUndefined();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("does not mint for a project the original bearer cannot access", async () => {
    mocks.query.mockResolvedValueOnce([
      { _id: "other-project", organizationId: "project-org" },
    ]);
    const { error, getBearer } = await authorize();
    expect(error).toMatchObject({ status: 403 });
    expect(getBearer).toBeUndefined();
    expect(mint).not.toHaveBeenCalled();
  });

  it("fails authorization immediately if the backend refuses delegation", async () => {
    mint.mockResolvedValueOnce(Response.json({ ok: false }, { status: 403 }));
    const { error, getBearer } = await authorize();
    expect(error).toMatchObject({ status: 403 });
    expect(getBearer).toBeUndefined();
  });

  it("keeps guests on their original credential without elevation", async () => {
    const { getBearer, error } = await authorize((c) =>
      c.set("guestId", "guest-1"),
    );
    expect(error).toBeUndefined();
    expect(await getBearer!()).toBe("browser-token");
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });

  it("preserves existing API-key delegation", async () => {
    const { getBearer, error } = await authorize((c) => {
      c.set("authMethod", "workos_api_key");
      c.set("workosUserId", subject);
      c.set("mcpjamOrganizationId", "key-org");
    });
    expect(error).toBeUndefined();
    expect(await getBearer!()).toBe("execution-token-1");
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mint.mock.calls[0][1].headers).toMatchObject({
      "x-mcpjam-acting-in-org": "key-org",
    });
  });
});
