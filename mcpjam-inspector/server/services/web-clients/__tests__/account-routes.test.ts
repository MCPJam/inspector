/**
 * The sign-in and save routes against a recorded backend and a canned
 * claude.ai page. Evidence: fixture.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebAccountRoutes, type WebAccountRouteDeps } from "../account-routes";
import { reportRouteFailure } from "../../../utils/route-error-report";

vi.mock("../../../utils/route-error-report", () => ({ reportRouteFailure: vi.fn() }));
import { PageDriverError, pollUntil, type PageDriver } from "../../../utils/harness/real-ui/page-driver";
import { BrowserdClientError } from "../../browserd/browserd-codec";

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
    expect(raced.deps.browser.release).toHaveBeenCalledOnce();
  });

  it("closes the browser when the storage outcome is unknown", async () => {
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

  it.each(["identity", "capture"] as const)("retries a failed %s check on the same browser", async (stage) => {
    const page = claudePage("team@example.com");
    const error = new Error("private browser details");
    const captureProfile = vi.fn(async () => new Uint8Array([1, 2, 3]));
    if (stage === "identity") {
      page.navigate = vi.fn(page.navigate).mockRejectedValueOnce(error);
    } else {
      captureProfile.mockRejectedValueOnce(error);
    }
    const { app, deps } = routes({
      browser: { ...routes().deps.browser, driver: async () => page, captureProfile },
    });
    const path = "/accounts/acct-1/save-profile";
    const first = await post(app, path, body);
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({
      code: "WEB_ACCOUNT_PROFILE_RETRY",
      message: expect.stringContaining(stage === "identity" ? "check which account" : "capture this browser"),
    });
    expect(deps.browser.release).not.toHaveBeenCalled();
    expect(deps.saveProfile).not.toHaveBeenCalled();
    expect(await (await post(app, path, body)).json()).toMatchObject({ ok: true });
    expect(deps.saveProfile).toHaveBeenCalledTimes(1);
    expect(deps.browser.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["the account check", "identity"],
    ["the profile export", "capture"],
  ] as const)("answers 409 and keeps the browser when the person holds it during %s", async (_what, stage) => {
    const page = claudePage("team@example.com");
    const captureProfile = vi.fn(async () => new Uint8Array([1, 2, 3]));
    if (stage === "identity") {
      page.navigate = vi.fn(page.navigate).mockRejectedValueOnce(
        new PageDriverError("person_has_browser", "a person has taken control of this browser"),
      );
    } else {
      captureProfile.mockRejectedValueOnce(new BrowserdClientError("lease_held", 423));
    }
    const { app, deps } = routes({
      browser: { ...routes().deps.browser, driver: async () => page, captureProfile },
    });
    const first = await post(app, "/accounts/acct-1/save-profile", body);
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ error: expect.stringContaining("You have control of the browser") });
    expect(deps.browser.release).not.toHaveBeenCalled();
    expect(deps.saveProfile).not.toHaveBeenCalled();
  });

  it("asks for a new sign-in, and lets the browser go, when the export failed after closing it", async () => {
    const captureProfile = vi.fn(async () => {
      throw new BrowserdClientError(
        'browser profile export failed with status 500: {"error":"profile_export_browser_closed: seat@example.com tar failed"}',
        500,
      );
    });
    const { app, deps } = routes({ browser: { ...routes().deps.browser, captureProfile } });
    const answer = await post(app, "/accounts/acct-1/save-profile", body);
    expect(answer.status).toBe(503);
    expect(await answer.json()).toMatchObject({ code: "WEB_ACCOUNT_SIGN_IN_ENDED", message: expect.stringContaining("Start signing in again") });
    expect(deps.browser.release).toHaveBeenCalledOnce();
    expect(deps.saveProfile).not.toHaveBeenCalled();
    // The report keeps the class, status and daemon token, and none of the page's text.
    const reported = vi.mocked(reportRouteFailure).mock.calls.at(-1)?.[1] as Error;
    expect(reported.message).toBe("capture: BrowserdClientError: 500: profile_export_browser_closed");
    expect(reported.cause).toBeInstanceOf(BrowserdClientError);
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
