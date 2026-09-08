import { describe, expect, it } from "vitest";
import {
  hasProjectDeepLinkParam,
  PROJECT_DEEP_LINK_PARAM,
  readProjectDeepLinkParam,
} from "../project-deep-link";

const A = "k5700000000000000000000000a";

/**
 * `?project=` is a LEGACY INPUT now. The project lives in the path
 * (`project-route.ts`), the ordering that resolves it lives in
 * `project-route-state.ts`, and what remains here is the reader that lets old
 * links — CLI run URLs, Slack messages, bookmarks — still open.
 */
describe("legacy ?project= reader", () => {
  it("names the parameter it accepts", () => {
    expect(PROJECT_DEEP_LINK_PARAM).toBe("project");
  });

  it("reads a usable id with or without the leading question mark", () => {
    expect(readProjectDeepLinkParam(`?project=${A}`)).toBe(A);
    expect(readProjectDeepLinkParam(`project=${A}`)).toBe(A);
    expect(readProjectDeepLinkParam(`?view=runs&project=${A}`)).toBe(A);
  });

  it("rejects a value that is not a project id", () => {
    // A mangled or hand-typed param must not suppress first-run onboarding
    // while the app waits for a project that will never resolve.
    expect(readProjectDeepLinkParam("?project=none")).toBeNull();
    expect(readProjectDeepLinkParam("?project=oops")).toBeNull();
    expect(readProjectDeepLinkParam("?project=")).toBeNull();
    expect(readProjectDeepLinkParam("")).toBeNull();
  });

  it("reports presence only for a usable id", () => {
    expect(hasProjectDeepLinkParam(`?project=${A}`)).toBe(true);
    expect(hasProjectDeepLinkParam("?project=oops")).toBe(false);
    expect(hasProjectDeepLinkParam("?other=1")).toBe(false);
  });
});
