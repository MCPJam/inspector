/**
 * The deployed account routes keep each sign-in browser for the person,
 * project and account that opened it. Another person's id, or the opener's
 * id sent for another account, finds no browser: nothing is read from it or
 * exported, and the route says to start the sign-in again. A browser closes
 * once its save is over, when its sign-in page fails to open, or two hours
 * after it opened. Only a backend that says the person manages the project's
 * web accounts opens one: a backend without that check is refused like a
 * member. The backend, the hosted browser and the person's session are
 * fixtures; the routes and the
 * claude.ai page module are real. Evidence: fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import {
  pollUntil,
  type PageDriver,
} from "../../../utils/harness/real-ui/page-driver";

const fixture = vi.hoisted(() => ({
  page: undefined as unknown,
  /** The backend's answer to the manage check. */
  manage: (async () => ({ allowed: true })) as () => Promise<unknown>,
  open: vi.fn(),
  /** Closes the hosted session, as the bearer it is given names the person. */
  close: vi.fn(async (_bearer?: string) => undefined),
  exportProfile: vi.fn(async () => new Uint8Array([1, 2, 3])),
  saveWebAccountProfile: vi.fn(async () => ({
    ok: true as const,
    profileVersion: 5,
  })),
}));

vi.mock("../backend-connector-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../backend-connector-resolver.js")
  >()),
  webClientService: () => ({
    read: async (command: { action: string; projectId: string }) => {
      if (command.action === "mayManageWebAccounts") return fixture.manage();
      if (command.projectId !== "p1") return [];
      return [
        {
          webAccountId: "acct-1",
          vendor: "claude",
          accountEmail: "team@example.com",
        },
        // No saved email, so only the browser check stands in the way.
        { webAccountId: "acct-2", vendor: "claude" },
      ];
    },
    apply: async () => null,
  }),
}));
vi.mock("../endpoint-auth.js", () => ({
  webClientsEnabledFor: async () => true,
}));
vi.mock("../../../utils/flag-identity.js", () => ({
  verifiedFlagSubject: async () => ({ kind: "id", distinctId: "subject" }),
}));
vi.mock("../hosted-web-client-runtime.js", () => ({
  // "Bearer user_a" is user_a.
  actorFromBearer: async (bearer: string) => ({
    actorExternalId: bearer.replace(/^Bearer\s+/i, ""),
  }),
  restoreWebProfile: async () => new Uint8Array(),
}));
vi.mock("../recovery/convex-backend.js", () => ({
  createConvexWebReconnectBackend: () => ({
    saveWebAccountProfile: fixture.saveWebAccountProfile,
  }),
}));
vi.mock("../hosted-browser.js", () => ({
  openWebClientHostedBrowser: async () => {
    fixture.open();
    return {
      browserSessionId: "browser-session-1",
      chatSessionId: "chat-1",
      driver: fixture.page,
      exportProfile: fixture.exportProfile,
      close: fixture.close,
    };
  },
}));

import { createDefaultWebAccountRoutes } from "../account-routes-default";
import { forgetSignInBrowsers } from "../sign-in-browsers";

/** A claude.ai page signed in as team@example.com. */
function claudePage(): PageDriver {
  vi.stubGlobal("fetch", async (target: string) => {
    const path = new URL(target).pathname;
    const body =
      path === "/api/account"
        ? { email_address: "team@example.com" }
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

const post = (
  app: ReturnType<typeof createDefaultWebAccountRoutes>,
  person: string,
  path: string,
  body: unknown,
) =>
  app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${person}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const GONE = {
  error:
    "This sign-in browser was started elsewhere or has closed. Start the sign-in again.",
};

beforeEach(() => {
  fixture.page = claudePage();
  fixture.manage = async () => ({ allowed: true });
  fixture.open.mockClear();
  fixture.close.mockClear();
  fixture.exportProfile.mockClear();
  fixture.saveWebAccountProfile.mockClear();
});

afterEach(() => {
  forgetSignInBrowsers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The browser's hosted session closed as the person who opened it. */
const CLOSED = ["Bearer user_a"];

describe("a sign-in browser on the deployed account routes", () => {
  it("saves the profile for the person and account that opened it", async () => {
    const app = createDefaultWebAccountRoutes();
    const started = await post(app, "user_a", "/accounts/acct-1/sign-in", {
      projectId: "p1",
    });
    expect(await started.json()).toEqual({
      browserSessionId: "browser-session-1",
      chatSessionId: "chat-1",
    });
    const saved = await post(app, "user_a", "/accounts/acct-1/save-profile", {
      projectId: "p1",
      browserSessionId: "browser-session-1",
    });
    expect(await saved.json()).toMatchObject({
      ok: true,
      accountEmail: "team@example.com",
    });
    expect(fixture.exportProfile).toHaveBeenCalledTimes(1);
    expect(fixture.close.mock.calls).toEqual([CLOSED]);
    const again = await post(app, "user_a", "/accounts/acct-1/save-profile", {
      projectId: "p1",
      browserSessionId: "browser-session-1",
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual(GONE);
  });

  it("closes a browser whose sign-in page failed to open, since nobody gets its id", async () => {
    fixture.page = {
      ...claudePage(),
      navigate: async () => {
        throw new Error("The browser went away.");
      },
    };
    const app = createDefaultWebAccountRoutes();
    const started = await post(app, "user_a", "/accounts/acct-1/sign-in", {
      projectId: "p1",
    });
    expect(started.status).toBe(500);
    expect(fixture.close.mock.calls).toEqual([CLOSED]);
    const saved = await post(app, "user_a", "/accounts/acct-1/save-profile", {
      projectId: "p1",
      browserSessionId: "browser-session-1",
    });
    expect(saved.status).toBe(409);
    expect(fixture.exportProfile).not.toHaveBeenCalled();
  });

  it("refuses its id from another person or for another account, and exports nothing", async () => {
    const app = createDefaultWebAccountRoutes();
    await post(app, "user_a", "/accounts/acct-1/sign-in", { projectId: "p1" });
    const body = { projectId: "p1", browserSessionId: "browser-session-1" };
    for (const [person, account] of [
      ["user_b", "acct-2"],
      ["user_b", "acct-1"],
      ["user_a", "acct-2"],
    ]) {
      const response = await post(
        app,
        person,
        `/accounts/${account}/save-profile`,
        body,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(GONE);
    }
    expect(fixture.exportProfile).not.toHaveBeenCalled();
    expect(fixture.saveWebAccountProfile).not.toHaveBeenCalled();
  });

  it("says to start again when this replica holds no such browser", async () => {
    const response = await post(
      createDefaultWebAccountRoutes(),
      "user_a",
      "/accounts/acct-1/save-profile",
      { projectId: "p1", browserSessionId: "opened-on-another-replica" },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(GONE);
  });
});

describe("who may open a sign-in browser on the deployed routes", () => {
  const save = { projectId: "p1", browserSessionId: "browser-session-1" };

  it("refuses everyone while the backend has no manage check, opening and exporting nothing", async () => {
    const app = createDefaultWebAccountRoutes();
    await post(app, "user_a", "/accounts/acct-1/sign-in", { projectId: "p1" });
    fixture.open.mockClear();
    // How a backend without the check answers a read it doesn't know.
    fixture.manage = async () => {
      throw new ConvexError({ code: "INVALID_WEB_CLIENT_REQUEST" });
    };
    const started = await post(app, "user_a", "/accounts/acct-1/sign-in", {
      projectId: "p1",
    });
    expect(started.status).toBe(503);
    const saved = await post(
      app,
      "user_a",
      "/accounts/acct-1/save-profile",
      save,
    );
    expect(saved.status).toBe(503);
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.exportProfile).not.toHaveBeenCalled();
    expect(fixture.saveWebAccountProfile).not.toHaveBeenCalled();
  });

  it("refuses a member, and treats no other failure of the check as unknown", async () => {
    fixture.manage = async () => ({ allowed: false });
    const member = await post(
      createDefaultWebAccountRoutes(),
      "user_a",
      "/accounts/acct-1/sign-in",
      { projectId: "p1" },
    );
    expect(member.status).toBe(403);
    // The same refusal for an account the project's list doesn't name is a no.
    fixture.manage = async () => {
      throw new ConvexError({ code: "INVALID_WEB_CLIENT_REQUEST" });
    };
    const elsewhere = await post(
      createDefaultWebAccountRoutes(),
      "user_a",
      "/accounts/acct-9/sign-in",
      { projectId: "p1" },
    );
    expect(elsewhere.status).toBe(403);
    for (const failure of [
      new Error("fetch failed"),
      new ConvexError({ code: "UNKNOWN_ACTOR" }),
    ]) {
      fixture.manage = async () => {
        throw failure;
      };
      const response = await post(
        createDefaultWebAccountRoutes(),
        "user_a",
        "/accounts/acct-1/sign-in",
        { projectId: "p1" },
      );
      expect(response.status).toBe(500);
    }
    expect(fixture.open).not.toHaveBeenCalled();
  });
});

describe("a sign-in browser's life on the deployed routes", () => {
  const save = { projectId: "p1", browserSessionId: "browser-session-1" };

  it("closes once its profile is saved, and its id opens nothing after", async () => {
    const app = createDefaultWebAccountRoutes();
    await post(app, "user_a", "/accounts/acct-1/sign-in", { projectId: "p1" });
    expect(
      await (
        await post(app, "user_a", "/accounts/acct-1/save-profile", save)
      ).json(),
    ).toMatchObject({ ok: true });
    expect(fixture.close).toHaveBeenCalledTimes(1);
    const again = await post(
      app,
      "user_a",
      "/accounts/acct-1/save-profile",
      save,
    );
    expect(again.status).toBe(409);
    expect(fixture.exportProfile).toHaveBeenCalledTimes(1);
  });

  it("stays open while the person finishes signing in", async () => {
    const app = createDefaultWebAccountRoutes();
    await post(app, "user_a", "/accounts/acct-1/sign-in", { projectId: "p1" });
    // The page the kept browser drives, still on the sign-in page.
    const page = fixture.page as PageDriver;
    Object.assign(page, { url: async () => "https://claude.ai/login" });
    expect(
      await (
        await post(app, "user_a", "/accounts/acct-1/save-profile", save)
      ).json(),
    ).toEqual({
      ok: false,
      reason: "not_signed_in",
    });
    expect(fixture.close).not.toHaveBeenCalled();
    Object.assign(page, { url: async () => "https://claude.ai/new" });
    expect(
      await (
        await post(app, "user_a", "/accounts/acct-1/save-profile", save)
      ).json(),
    ).toMatchObject({ ok: true });
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it("closes when the save fails", async () => {
    const app = createDefaultWebAccountRoutes();
    await post(app, "user_a", "/accounts/acct-1/sign-in", { projectId: "p1" });
    fixture.saveWebAccountProfile.mockRejectedValueOnce(
      new Error("The upload stopped."),
    );
    expect(
      (await post(app, "user_a", "/accounts/acct-1/save-profile", save)).status,
    ).toBe(500);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(
      (await post(app, "user_a", "/accounts/acct-1/save-profile", save)).status,
    ).toBe(409);
  });

  it("closes two hours after it opened when nobody saved it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const app = createDefaultWebAccountRoutes();
    await post(app, "user_a", "/accounts/acct-1/sign-in", { projectId: "p1" });
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 - 1);
    expect(fixture.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    expect(
      (await post(app, "user_a", "/accounts/acct-1/save-profile", save)).status,
    ).toBe(409);
    expect(fixture.exportProfile).not.toHaveBeenCalled();
  });
});
