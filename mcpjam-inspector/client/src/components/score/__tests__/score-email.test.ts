import { describe, expect, it } from "vitest";
import { normalizeScoreEmail } from "../score-email";

describe("normalizeScoreEmail", () => {
  it("trims a valid address", () => {
    expect(normalizeScoreEmail("  dev@acme.com  ")).toBe("dev@acme.com");
  });

  it.each([
    "",
    "not-an-email",
    "@acme.com",
    "dev@localhost",
    "dev @acme.com",
    "dev@team@acme.com",
  ])("rejects %j", (value) => {
    expect(normalizeScoreEmail(value)).toBeNull();
  });
});
