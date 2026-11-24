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
    playwrightSelectors: true,
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
    mayManage: async () => true,
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
      release: vi.fn(async () => undefined),
    },
    ...overrides,
  };
  return { app: createWebAccountRoutes(deps), deps, applied };
}

const post = (app: ReturnType<typeof routes>["app"], path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
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
      bearer: "",
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

  it("refuses a member, and anyone the backend can't say manages accounts, opening no browser", async () => {
    const member = routes({ mayManage: async () => false });
    expect((await post(member.app, "/accounts/acct-1/sign-in", { projectId: "p1" })).status).toBe(403);
    const unknown = routes({ mayManage: async () => undefined });
    expect((await post(unknown.app, "/accounts/acct-1/sign-in", { projectId: "p1" })).status).toBe(503);
    expect(member.deps.browser.start).not.toHaveBeenCalled();
    expect(unknown.deps.browser.start).not.toHaveBeenCalled();
  });
});

describe("POST /accounts/:id/save-profile", () => {
  const body = { projectId: "p1", browserSessionId: "browser-session-1" };

  it("saves the profile against its version, marks the account verified, and closes the browser", async () => {
    const { app, deps, applied } = routes();
    expect(await (await post(app, "/accounts/acct-1/save-profile", body, { authorization: "Bearer saver" })).json()).toEqual({
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
    expect(deps.browser.release).toHaveBeenCalledWith({ ...body, actor: ACTOR, webAccountId: "acct-1", bearer: "Bearer saver" });
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
    // The person fixes the first two in the same browser; someone else's save ends it.
    expect(signedOut.deps.browser.release).not.toHaveBeenCalled();
    expect(other.deps.browser.release).not.toHaveBeenCalled();
    expect(raced.deps.browser.release).toHaveBeenCalledTimes(1);
  });

  it("closes the browser when reading it or saving from it fails", async () => {
    const unreadable = routes({
      browser: {
        ...routes().deps.browser,
        driver: async () => ({
          ...claudePage("team@example.com"),
          navigate: async () => {
            throw new Error("The browser went away.");
          },
        }),
      },
    });
    expect((await post(unreadable.app, "/accounts/acct-1/save-profile", body)).status).toBe(500);
    expect(unreadable.deps.browser.release).toHaveBeenCalledTimes(1);
    const offline = routes({
      saveProfile: async () => {
        throw new Error("socket hang up");
      },
    });
    expect((await post(offline.app, "/accounts/acct-1/save-profile", body)).status).toBe(500);
    expect(offline.deps.browser.release).toHaveBeenCalledTimes(1);
    expect(offline.applied).toEqual([]);
  });

  it("refuses a save for anyone the backend can't say manages accounts, reading no browser", async () => {
    const driver = vi.fn(async () => claudePage("team@example.com"));
    const unknown = routes({ mayManage: async () => undefined, browser: { ...routes().deps.browser, driver } });
    expect((await post(unknown.app, "/accounts/acct-1/save-profile", body)).status).toBe(503);
    expect(driver).not.toHaveBeenCalled();
    expect(unknown.deps.saveProfile).not.toHaveBeenCalled();
  });

  it("closes the browser once the save is over: saved, saved first by someone else, or failed", async () => {
    const saved = routes();
    expect((await post(saved.app, "/accounts/acct-1/save-profile", body)).status).toBe(200);
    const raced = routes({
      saveProfile: async () => ({ ok: false, reason: "version_conflict", profileVersion: 5 }),
    });
    expect((await post(raced.app, "/accounts/acct-1/save-profile", body)).status).toBe(200);
    const exportFailed = routes({
      browser: {
        ...routes().deps.browser,
        captureProfile: async () => {
          throw new Error("The export stopped.");
        },
      },
    });
    const pageGone = routes({
      browser: {
        ...routes().deps.browser,
        driver: async () => ({
          ...claudePage("team@example.com"),
          navigate: async () => {
            throw new Error("The page closed.");
          },
        }),
      },
    });
    for (const failed of [exportFailed, pageGone]) {
      expect((await post(failed.app, "/accounts/acct-1/save-profile", body)).status).toBe(500);
    }
    for (const { deps } of [saved, raced, exportFailed, pageGone]) {
      expect(deps.browser.release).toHaveBeenCalledWith({ actor: ACTOR, ...body, webAccountId: "acct-1", bearer: "" });
    }
  });

  it("keeps the browser open while the person finishes signing in or switches accounts", async () => {
    for (const email of [undefined, "someone@example.com"]) {
      const { app, deps } = routes({
        browser: { ...routes().deps.browser, driver: async () => claudePage(email) },
      });
      expect(await (await post(app, "/accounts/acct-1/save-profile", body)).json()).toMatchObject({ ok: false });
      expect(deps.browser.release).not.toHaveBeenCalled();
    }
  });
});

describe("an account of a vendor this Inspector doesn't drive yet", () => {
  const service = {
    read: async () => [{ webAccountId: "acct-2", vendor: "another-vendor" }, ROW],
    apply: async () => null,
  };

  it("leaves both routes working for the project's other accounts", async () => {
    const { app } = routes({ service });
    expect(await (await post(app, "/accounts/acct-1/sign-in", { projectId: "p1" })).json()).toEqual({
      browserSessionId: "browser-session-1",
    });
    const saved = await post(app, "/accounts/acct-1/save-profile", { projectId: "p1", browserSessionId: "browser-session-1" });
    expect(await saved.json()).toMatchObject({ ok: true, accountEmail: "team@example.com" });
  });

  it("refuses to sign that account in, and says why", async () => {
    const { app, deps } = routes({ service });
    const response = await post(app, "/accounts/acct-2/sign-in", { projectId: "p1" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "This version of MCPJam can't sign in this kind of web account. Update MCPJam, then try again.",
    });
    expect(deps.browser.start).not.toHaveBeenCalled();
  });
});
