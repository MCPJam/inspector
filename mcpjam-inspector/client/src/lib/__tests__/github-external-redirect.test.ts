import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  redirectToGithub,
  UnsafeRedirectError,
} from "../github-external-redirect";

// The binding flow's redirects are URLs the BACKEND built — it is the only side
// that knows the App slug, the OAuth client id, and the one-time state. So the
// allowlist here is not defending against the backend; it is making sure this
// function never becomes a general-purpose `window.location.assign(userInput)`
// the day something less trustworthy calls it.

const assign = vi.fn();

beforeEach(() => {
  assign.mockClear();
  // jsdom's `window.location` is not writable, and `assign` throws
  // "not implemented" if left alone. Replacing the property is the only way to
  // observe where a redirect would have gone.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { assign },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redirectToGithub", () => {
  it.each([
    "https://github.com/apps/mcpjam/installations/new?state=abc",
    "https://github.com/login/oauth/authorize?client_id=Iv1.x&state=def",
  ])("follows %s", (url) => {
    redirectToGithub(url);
    expect(assign).toHaveBeenCalledWith(url);
  });

  it.each([
    // The one a `startsWith` check would wave through, which is exactly how
    // that gets shipped.
    "https://github.com.evil.test/apps/mcpjam",
    "https://evil.test/apps/mcpjam",
    // Same host, wrong scheme — an http redirect would strip TLS from a flow
    // whose whole point is proving an identity.
    "http://github.com/apps/mcpjam",
    "javascript:alert(1)",
    "not a url at all",
    "",
  ])("refuses %s", (url) => {
    expect(() => redirectToGithub(url)).toThrow(UnsafeRedirectError);
    expect(assign).not.toHaveBeenCalled();
  });
});
