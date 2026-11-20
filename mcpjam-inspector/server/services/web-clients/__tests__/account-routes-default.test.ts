/**
 * The deployed account routes keep each sign-in browser for the person,
 * project and account that opened it. Another person's id, or the opener's
 * id sent for another account, finds no browser: nothing is read from it or
 * exported, and the route says to start the sign-in again. The backend, the
 * hosted browser and the person's session are fixtures; the routes and the
 * claude.ai page module are real. Evidence: fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pollUntil,
  type PageDriver,
} from "../../../utils/harness/real-ui/page-driver";

const fixture = vi.hoisted(() => ({
  page: undefined as unknown,
  exportProfile: vi.fn(async () => new Uint8Array([1, 2, 3])),
  saveWebAccountProfile: vi.fn(async () => ({
    ok: true as const,
    profileVersion: 5,
  })),
}));

vi.mock("../backend-connector-resolver.js", () => ({
  webClientService: () => ({
    read: async (command: { action: string; projectId: string }) => {
      if (command.action === "mayManageWebAccounts") return { allowed: true };
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
  openWebClientHostedBrowser: async () => ({
    browserSessionId: "browser-session-1",
    chatSessionId: "chat-1",
    driver: fixture.page,
    exportProfile: fixture.exportProfile,
  }),
}));

import { createDefaultWebAccountRoutes } from "../account-routes-default";

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
  fixture.exportProfile.mockClear();
  fixture.saveWebAccountProfile.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
