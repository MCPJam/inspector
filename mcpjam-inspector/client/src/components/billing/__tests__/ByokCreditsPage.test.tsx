import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ByokCreditsPage } from "../ByokCreditsPage";

function sectionOf(heading: string): HTMLElement {
  return screen.getByRole("heading", { name: heading }).closest("section")!;
}

describe("ByokCreditsPage", () => {
  it("points the credits paragraph at the organization keys section", () => {
    render(<ByokCreditsPage />);
    const section = sectionOf("MCPJam features still use credits");
    expect(section).toHaveTextContent(
      "BYOK does not add MCPJam credits or cover usage of Evals, Swarm, User Testing, or Insights.",
    );
    expect(section).toHaveTextContent(
      "An organization that uses its own keys for all AI features is billed differently; see below.",
    );
  });

  it("explains how an organization's own keys are billed", () => {
    render(<ByokCreditsPage />);
    const section = sectionOf(
      "When your organization uses its keys for all AI features",
    );
    expect(section).toHaveTextContent("On Enterprise plans");
    expect(section).toHaveTextContent(
      "which bill the model tokens instead of MCPJam credits",
    );
    expect(section).toHaveTextContent(
      "MCPJam’s fixed product fees and usage limits still apply",
    );
  });

  it("says background work waits for the organization's default AI model", () => {
    render(<ByokCreditsPage />);
    const section = sectionOf(
      "When your organization uses its keys for all AI features",
    );
    expect(section).toHaveTextContent(
      "Swarm, User Testing and Insights are unavailable until an admin sets the organization’s default AI model in Organization → AI providers.",
    );
  });
});
