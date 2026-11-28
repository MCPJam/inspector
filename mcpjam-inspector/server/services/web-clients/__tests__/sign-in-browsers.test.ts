/**
 * A sign-in browser is found only by the person, project and account it was
 * opened for, and only for two hours. Every browser the store lets go is
 * closed: once the account is saved, when its time is up whether or not
 * anyone reads it, and when it is read past its time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebClientHostedBrowser } from "../hosted-browser.js";
import {
  findSignInBrowser,
  forgetSignInBrowsers,
  keepSignInBrowser,
  releaseSignInBrowser,
  signInBrowserAccount,
} from "../sign-in-browsers.js";

const ADMIN = { actorExternalId: "user_admin" };
const browser = (id: string) =>
  ({
    browserSessionId: id,
    chatSessionId: `chat-${id}`,
  }) as unknown as WebClientHostedBrowser;
/** Each close, as the browser and the bearer it closed with. */
const closed = vi.fn(async (_id: string, _bearer?: string) => {});
const kept = (id: string) =>
  keepSignInBrowser({
    browser: browser(id),
    actor: ADMIN,
    projectId: "project-1",
    webAccountId: "web-account-1",
    close: (bearer) => closed(id, bearer),
  });
const lookup = (id: string) => ({
  browserSessionId: id,
  actor: ADMIN,
  projectId: "project-1",
});
const TWO_HOURS = 2 * 60 * 60_000;

beforeEach(() => closed.mockClear());

afterEach(() => {
  forgetSignInBrowsers();
  vi.useRealTimers();
});

describe("sign-in browsers", () => {
  it("finds the browser for the person, project and account it was opened for", () => {
    kept("browser-1");
    expect(
      findSignInBrowser({
        ...lookup("browser-1"),
        webAccountId: "web-account-1",
      })?.browserSessionId,
    ).toBe("browser-1");
    expect(signInBrowserAccount(lookup("browser-1"))).toBe("web-account-1");
    expect(
      findSignInBrowser({
        ...lookup("browser-1"),
        webAccountId: "web-account-2",
      }),
    ).toBeUndefined();
    expect(
      findSignInBrowser({
        ...lookup("browser-1"),
        webAccountId: "web-account-1",
        projectId: "project-2",
      }),
    ).toBeUndefined();
    expect(
      findSignInBrowser({
        ...lookup("browser-1"),
        webAccountId: "web-account-1",
        actor: { actorUserId: "user_admin" },
      }),
    ).toBeUndefined();
    expect(closed).not.toHaveBeenCalled();
  });

  it("forgets a browser read two hours after it opened, with no browser opened since, and closes it", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 20, 10) });
    kept("browser-1");
    // The clock moves without running timers, so only the read's own check can forget it.
    vi.setSystemTime(Date.now() + TWO_HOURS);
    expect(signInBrowserAccount(lookup("browser-1"))).toBe("web-account-1");
    vi.setSystemTime(Date.now() + 1);
    expect(
      findSignInBrowser({
        ...lookup("browser-1"),
        webAccountId: "web-account-1",
      }),
    ).toBeUndefined();
    expect(signInBrowserAccount(lookup("browser-1"))).toBeUndefined();
    expect(closed.mock.calls).toEqual([["browser-1", undefined]]);
  });

  it("closes a browser nobody reads two hours after it opened", () => {
    vi.useFakeTimers();
    kept("browser-1");
    vi.advanceTimersByTime(TWO_HOURS - 1);
    expect(closed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(closed.mock.calls).toEqual([["browser-1", undefined]]);
    expect(signInBrowserAccount(lookup("browser-1"))).toBeUndefined();
  });

  it("lets the person's own browser go once its account is saved, closing it with their bearer", () => {
    vi.useFakeTimers();
    kept("browser-1");
    const release = { ...lookup("browser-1"), bearer: "Bearer fresh" };
    releaseSignInBrowser({
      ...release,
      actor: { actorExternalId: "user_other" },
      webAccountId: "web-account-1",
    });
    releaseSignInBrowser({ ...release, webAccountId: "web-account-2" });
    expect(closed).not.toHaveBeenCalled();
    releaseSignInBrowser({ ...release, webAccountId: "web-account-1" });
    expect(closed.mock.calls).toEqual([["browser-1", "Bearer fresh"]]);
    expect(signInBrowserAccount(lookup("browser-1"))).toBeUndefined();
    // Its timer went with it: the browser closes once.
    vi.advanceTimersByTime(TWO_HOURS);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
