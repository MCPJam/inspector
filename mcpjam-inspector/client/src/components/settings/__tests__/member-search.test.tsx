import { describe, expect, it } from "vitest";
import { matchesMember } from "../MemberSearch";
describe("Member filtering", () => {
  const member = { email: "ada@example.com", user: { name: "Ada Lovelace" } };
  it("searches name and email case-insensitively", () => {
    expect(matchesMember(member, "  LOVELACE ", "admin", "all")).toBe(true);
    expect(matchesMember(member, "ADA@", "admin", "all")).toBe(true);
    expect(matchesMember(member, "unknown", "admin", "all")).toBe(false);
  });
  it("combines role and search and includes pending invitations", () => {
    expect(matchesMember(member, "ada", "admin", "member")).toBe(false);
    expect(matchesMember(member, "ada", "admin", "admin")).toBe(true);
    expect(
      matchesMember(
        { email: "pending@example.com" },
        "pending",
        "pending",
        "pending",
      ),
    ).toBe(true);
  });
});
