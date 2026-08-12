import { describe, expect, it } from "vitest";
import {
  extractTesterLinkToken,
  TESTER_LINK_PATH_SEGMENT,
  TESTER_LINK_RUNTIME_PATH_PATTERN,
} from "../tester-link-path";

describe("tester-link-path", () => {
  it("mints links under the product's own name", () => {
    expect(TESTER_LINK_PATH_SEGMENT).toBe("user-testing");
  });

  it("keeps resolving links already handed to testers", () => {
    // The `/chatbox/…` shape is live in shared links, in the Convex public
    // API's `link.url`, and in already-delivered invite emails. Accepting it
    // here is what keeps those working — there is no redirect behind it.
    expect(extractTesterLinkToken("/chatbox/demo/tok_1")).toBe("tok_1");
    expect(TESTER_LINK_RUNTIME_PATH_PATTERN.test("/chatbox/demo/tok_1")).toBe(
      true
    );
  });

  it("does not mistake the in-app scenario screen for a tester link", () => {
    // `/user-testing/<scenarioId>` is a signed-in app screen. A prefix test
    // here would hand it to the public runtime instead, and the misrouted-
    // pushState guard in main.tsx would stop treating a real embed as one.
    for (const appPath of [
      "/user-testing",
      "/user-testing/new",
      "/user-testing/host_123",
      "/user-testing/host_123/",
    ]) {
      expect(extractTesterLinkToken(appPath)).toBeNull();
      expect(TESTER_LINK_RUNTIME_PATH_PATTERN.test(appPath)).toBe(false);
    }
  });

  it("reads the token through a preview query or a slug bookmark", () => {
    expect(
      extractTesterLinkToken("/user-testing/demo/tok_1?surface=preview")
    ).toBe("tok_1");
    expect(extractTesterLinkToken("/user-testing/demo/tok_1#demo")).toBe(
      "tok_1"
    );
    expect(extractTesterLinkToken("/user-testing/demo/tok%201")).toBe("tok 1");
  });

  it("keeps the iframe guard closed on everything else", () => {
    for (const otherPath of [
      "/oauth/callback/mcp",
      "/user-testing/demo/tok_1/extra",
      "/servers",
      "/",
    ]) {
      expect(TESTER_LINK_RUNTIME_PATH_PATTERN.test(otherPath)).toBe(false);
    }
  });
});
