import { describe, expect, it } from "vitest";
import { normalizeScoreEmail } from "../score-email";

const DOMAIN = "@acme.com";
const emailOfLength = (length: number) =>
  `${"a".repeat(length - DOMAIN.length)}${DOMAIN}`;

describe("normalizeScoreEmail", () => {
  it("trims a valid address", () => {
    expect(normalizeScoreEmail("  dev@acme.com  ")).toBe("dev@acme.com");
  });

  it("accepts an address at the 320-character maximum", () => {
    const email = emailOfLength(320);

    expect(email).toHaveLength(320);
    expect(normalizeScoreEmail(`  ${email}  `)).toBe(email);
  });

  it("rejects an address one character over the maximum", () => {
    const email = emailOfLength(321);

    expect(email).toHaveLength(321);
    expect(normalizeScoreEmail(email)).toBeNull();
  });

  it.each([
    "",
    "not-an-email",
    "@acme.com",
    "dev@localhost",
    "dev @acme.com",
    "dev@team@acme.com",
    "   ",
    "dev@acme.",
    "dev@.com",
    "dev@",
  ])("rejects %j", (value) => {
    expect(normalizeScoreEmail(value)).toBeNull();
  });
});
