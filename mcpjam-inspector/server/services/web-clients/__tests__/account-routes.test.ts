/**
 * The sign-in and save routes against a recorded backend and a canned
 * claude.ai page. Evidence: fixture.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebAccountRoutes, type WebAccountRouteDeps } from "../account-routes";
import { pollUntil, type PageDriver } from "../../../utils/harness/real-ui/page-driver";

const ACTOR = { actorExternalId: "user_admin" };
const ROW = {
  webAccountId: "acct-1",
  vendor: "claude",
  hasProfile: true,
  profileVersion: 4,
  accountEmail: "team@example.com",
};

/** A signed-in claude.ai page whose own API answers `email`. */
function claudePage(email: string | undefined): PageDriver {
  vi.stubGlobal("fetch", async (target: string) => {
    const path = new URL(target).pathname;
    const body =
      path === "/api/account"
        ? { email_address: email }
        : path === "/api/organizations"
          ? [{ uuid: "org", name: "Team", capabilities: ["chat"] }]
          : {};
    return new Response(JSON.stringify(body));
  });
  return {
    kind: "playwright",
    canEvaluate: true,
    navigate: async () => undefined,
    url: async () => "https://claude.ai/new",
    evaluate: async (fn, arg) => fn(arg),
    waitFor: pollUntil,
    click: async () => undefined,
    type: async () => undefined,
    press: async () => undefined,
    readText: async (selector) =>
      selector === '[data-testid="chat-input"]' ? "" : undefined,
  };
}

function routes(overrides: Partial<WebAccountRouteDeps> = {}) {
  const applied: Array<Record<string, unknown>> = [];
  const deps: WebAccountRouteDeps = {
    actorOf: async () => ACTOR,
    isEnabled: async () => true,
    requireManage: async () => undefined,
    service: {
      read: async () => [ROW],
      apply: async (command) => {
        applied.push(command);
        return null;
      },
    },
    saveProfile: vi.fn(async () => ({ ok: true as const, profileVersion: 5 })),
    browser: {
      start: vi.fn(async () => ({ browserSessionId: "browser-session-1" })),
      driver: async () => claudePage("team@example.com"),
      captureProfile: async () => new Uint8Array([1, 2, 3]),
    },
    ...overrides,
  };
  return { app: createWebAccountRoutes(deps), deps, applied };
}

const post = (app: ReturnType<typeof routes>["app"], path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /accounts/:id/sign-in", () => {
  it("starts a hosted browser on the saved profile, open on the vendor's sign-in page", async () => {
    const { app, deps } = routes();
    const response = await post(app, "/accounts/acct-1/sign-in", { projectId: "p1" });
    expect(await response.json()).toEqual({ browserSessionId: "browser-session-1" });
    expect(deps.browser.start).toHaveBeenCalledWith({
      actor: ACTOR,
      projectId: "p1",
      webAccountId: "acct-1",
      restoreProfile: true,
      sites: ["https://claude.ai"],
      startUrl: "https://claude.ai/login",
    });
  });

  it("refuses a request with no signed-in user, or with the flag off", async () => {
    expect((await post(routes({ actorOf: async () => undefined }).app, "/accounts/acct-1/sign-in", { projectId: "p1" })).status).toBe(401);
    expect((await post(routes({ isEnabled: async () => false }).app, "/accounts/acct-1/sign-in", { projectId: "p1" })).status).toBe(404);
  });

  it("leaves the admin check to the backend's refusal", async () => {
    const { app } = routes({
      requireManage: async () => {
        throw new Error("FORBIDDEN");
      },
    });
    expect((await post(app, "/accounts/acct-1/sign-in", { projectId: "p1" })).status).toBe(500);
  });
});

describe("POST /accounts/:id/save-profile", () => {
  const body = { projectId: "p1", browserSessionId: "browser-session-1" };

  it("saves the profile against its version and marks the account verified", async () => {
    const { app, deps, applied } = routes();
    expect(await (await post(app, "/accounts/acct-1/save-profile", body)).json()).toEqual({
      ok: true,
      accountEmail: "team@example.com",
      workspaceName: "Team",
    });
    expect(deps.saveProfile).toHaveBeenCalledWith(ACTOR, {
      webAccountId: "acct-1",
      expectedProfileVersion: 4,
      profile: new Uint8Array([1, 2, 3]),
    });
    expect(applied).toEqual([
      {
        action: "markWebAccountVerified",
        webAccountId: "acct-1",
        accountEmail: "team@example.com",
        workspaceName: "Team",
        ...ACTOR,
      },
    ]);
  });

  it("answers not_signed_in, wrong_account and version_conflict without saving a wrong session", async () => {
    const signedOut = routes({
      browser: { ...routes().deps.browser, driver: async () => claudePage(undefined) },
    });
    expect(await (await post(signedOut.app, "/accounts/acct-1/save-profile", body)).json()).toEqual({
      ok: false,
      reason: "not_signed_in",
    });
    const other = routes({
      browser: { ...routes().deps.browser, driver: async () => claudePage("someone@example.com") },
    });
    expect(await (await post(other.app, "/accounts/acct-1/save-profile", body)).json()).toEqual({
      ok: false,
      reason: "wrong_account",
    });
    expect(other.deps.saveProfile).not.toHaveBeenCalled();
    const raced = routes({
      saveProfile: async () => ({ ok: false, reason: "version_conflict", profileVersion: 5 }),
    });
    expect(await (await post(raced.app, "/accounts/acct-1/save-profile", body)).json()).toEqual({
      ok: false,
      reason: "version_conflict",
    });
    expect(raced.applied).toEqual([]);
  });
});
