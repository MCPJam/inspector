/**
 * The declared-domain card in the Findings tab.
 *
 * It lives outside the blocked-request list on purpose: a `Diagnosis` means
 * "the browser refused a request", and the surfaces built on that type would
 * misdescribe a declaration mismatch. These tests pin that it renders on its
 * own terms, including when there are no violations at all.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OriginCard } from "../OriginCard";
import { FindingsTab } from "../FindingsTab";

describe("OriginCard", () => {
  it("renders nothing without a declaration", () => {
    const { container } = render(
      <OriginCard assignedOrigin="https://x.test" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("confirms a match", () => {
    render(
      <OriginCard
        declaredDomain="sandbox.mcpjam.com"
        assignedOrigin="https://sandbox.mcpjam.com"
      />,
    );
    expect(screen.getByText(/Matches the origin/)).toBeTruthy();
  });

  it("names the served origin and the consequence on a mismatch", () => {
    render(
      <OriginCard
        declaredDomain="abc.claudemcpcontent.com"
        assignedOrigin="https://sandbox.mcpjam.com"
      />,
    );
    expect(screen.getByText("abc.claudemcpcontent.com")).toBeTruthy();
    expect(screen.getByText("https://sandbox.mcpjam.com")).toBeTruthy();
    // The actionable part: what will not work, not merely that it differs.
    expect(screen.getByText(/will not match requests from/)).toBeTruthy();
  });

  it("calls out a value that is not a bare hostname", () => {
    render(
      <OriginCard
        declaredDomain="https://sandbox.mcpjam.com"
        assignedOrigin="https://sandbox.mcpjam.com"
      />,
    );
    expect(screen.getByText(/not a bare hostname/)).toBeTruthy();
  });
});

describe("FindingsTab — origin card placement", () => {
  it("shows the card even when there are no CSP violations", () => {
    // A widget can declare a mismatched domain and trip no violation at all.
    // If the card sat below the empty-state early return, that developer
    // would never see it.
    render(
      <FindingsTab
        diagnoses={[]}
        onViewPolicyDiff={() => {}}
        declaredDomain="abc.claudemcpcontent.com"
        assignedOrigin="https://sandbox.mcpjam.com"
      />,
    );
    expect(screen.getByText("Declared view domain")).toBeTruthy();
    expect(screen.getByText("No CSP violations recorded.")).toBeTruthy();
  });

  it("keeps the empty state clean when nothing was declared", () => {
    render(<FindingsTab diagnoses={[]} onViewPolicyDiff={() => {}} />);
    expect(screen.queryByText("Declared view domain")).toBeNull();
  });
});
