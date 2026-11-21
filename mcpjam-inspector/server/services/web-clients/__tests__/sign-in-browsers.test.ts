/** A sign-in browser is found only by the person, project and account it was opened for. */
import { afterEach, describe, expect, it } from "vitest";
import type { WebClientHostedBrowser } from "../hosted-browser.js";
import {
  findSignInBrowser,
  forgetSignInBrowsers,
  keepSignInBrowser,
  signInBrowserAccount,
} from "../sign-in-browsers.js";

const ADMIN = { actorExternalId: "user_admin" };
const browser = (id: string) =>
  ({
    browserSessionId: id,
    chatSessionId: `chat-${id}`,
  }) as unknown as WebClientHostedBrowser;
const kept = (id: string, now?: number) =>
  keepSignInBrowser(
    {
      browser: browser(id),
      actor: ADMIN,
      projectId: "project-1",
      webAccountId: "web-account-1",
    },
    now,
  );

afterEach(() => forgetSignInBrowsers());

describe("sign-in browsers", () => {
  it("finds the browser for the person, project and account it was opened for", () => {
    kept("browser-1");
    const lookup = {
      browserSessionId: "browser-1",
      actor: ADMIN,
      projectId: "project-1",
    };
    expect(
      findSignInBrowser({ ...lookup, webAccountId: "web-account-1" })
        ?.browserSessionId,
    ).toBe("browser-1");
    expect(signInBrowserAccount(lookup)).toBe("web-account-1");
    expect(
      findSignInBrowser({ ...lookup, webAccountId: "web-account-2" }),
    ).toBeUndefined();
    expect(
      findSignInBrowser({
        ...lookup,
        webAccountId: "web-account-1",
        projectId: "project-2",
      }),
    ).toBeUndefined();
    expect(
      findSignInBrowser({
        ...lookup,
        webAccountId: "web-account-1",
        actor: { actorUserId: "user_admin" },
      }),
    ).toBeUndefined();
  });

  it("forgets a browser two hours after it opened", () => {
    const start = Date.UTC(2026, 10, 20, 10);
    kept("browser-1", start);
    kept("browser-2", start + 2 * 60 * 60_000 + 1);
    const lookup = { actor: ADMIN, projectId: "project-1" };
    expect(
      signInBrowserAccount({ ...lookup, browserSessionId: "browser-1" }),
    ).toBeUndefined();
    expect(
      signInBrowserAccount({ ...lookup, browserSessionId: "browser-2" }),
    ).toBe("web-account-1");
  });
});
