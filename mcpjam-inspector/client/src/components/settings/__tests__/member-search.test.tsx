import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { matchesMember, MemberListHeader } from "../MemberSearch";
describe("MemberListHeader", () => {
  const counts = (requestCount: number) =>
    render(
      <MemberListHeader
        activeCount={4}
        pendingCount={1}
        requestCount={requestCount}
      />,
    );
  it("adds join requests after the active and pending counts", () => {
    counts(1);
    expect(
      screen.getByText("(4 active · 1 pending · 1 request)"),
    ).toBeInTheDocument();
  });
  it("counts several requests", () => {
    counts(2);
    expect(
      screen.getByText("(4 active · 1 pending · 2 requests)"),
    ).toBeInTheDocument();
  });
  it("says nothing about requests when there are none", () => {
    counts(0);
    expect(screen.getByText("(4 active · 1 pending)")).toBeInTheDocument();
  });
});
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
