/**
 * A sign-in browser is found only by the person, project and account it was
 * opened for, and only for two hours.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
const kept = (id: string) =>
  keepSignInBrowser({
    browser: browser(id),
    actor: ADMIN,
    projectId: "project-1",
    webAccountId: "web-account-1",
  });
const TWO_HOURS = 2 * 60 * 60_000;

afterEach(() => {
  forgetSignInBrowsers();
  vi.useRealTimers();
});

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

  it("forgets a browser read two hours after it opened, with no browser opened since", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 20, 10) });
    kept("browser-1");
    const lookup = {
      browserSessionId: "browser-1",
      actor: ADMIN,
      projectId: "project-1",
    };
    vi.setSystemTime(Date.now() + TWO_HOURS);
    expect(signInBrowserAccount(lookup)).toBe("web-account-1");
    vi.setSystemTime(Date.now() + 1);
    expect(
      findSignInBrowser({ ...lookup, webAccountId: "web-account-1" }),
    ).toBeUndefined();
    expect(signInBrowserAccount(lookup)).toBeUndefined();
  });
});
