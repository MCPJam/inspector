import { describe, expect, it } from "vitest";
import { errorPageTitle } from "../error-page";

describe("errorPageTitle", () => {
  it("returns the title text as written, neither trimmed nor decoded", () => {
    expect(
      errorPageTitle(
        '<html><head><title lang="en"> AT&amp;T Login </title></head></html>',
      ),
    ).toBe(" AT&amp;T Login ");
  });

  it("returns undefined for a page without a title", () => {
    expect(errorPageTitle("<html><body>502 upstream</body></html>")).toBe(
      undefined,
    );
  });

  // Both runs are bounded so a body of repeated `<title` stays a linear scan.
  it("ignores a title tag with more than 200 characters of attributes", () => {
    expect(
      errorPageTitle(`<title data-x="${"a".repeat(200)}">Web Login</title>`),
    ).toBe(undefined);
  });

  it("ignores a title longer than 200 characters", () => {
    expect(errorPageTitle(`<title>${"x".repeat(201)}</title>`)).toBe(undefined);
  });
});
