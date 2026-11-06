import { describe, expect, it } from "vitest";
import { canRouteWorkSignup } from "../work-signup-navigation";

describe("work signup destination", () => {
  it.each(["/", "/home", "/servers"])(
    "allows the generic entry %s",
    (entry) => {
      expect(canRouteWorkSignup(entry, "/p/abcdefghijklmnop/home")).toBe(true);
    },
  );
  it.each([
    "/p/abcdefghijklmnop/home",
    "/organizations/acme/members",
    "/oauth/callback",
    "/home?checkout=team",
    "/home?invite=one",
    "/home#return",
  ])("preserves explicit entry %s", (entry) => {
    expect(canRouteWorkSignup(entry, "/home")).toBe(false);
  });
  it.each([
    "/playground",
    "/organizations/acme/members",
    "/home?conversation=one",
  ])("preserves a later destination %s", (current) => {
    expect(canRouteWorkSignup("/home", current)).toBe(false);
  });
});
