import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ByokCreditsPage } from "../ByokCreditsPage";

describe("ByokCreditsPage", () => {
  it("explains how an organization's own keys are billed", () => {
    render(<ByokCreditsPage />);
    const section = screen
      .getByRole("heading", {
        name: "When your organization uses its keys for all AI features",
      })
      .closest("section")!;
    expect(section).toHaveTextContent(
      "Model tokens are billed by the organization’s providers",
    );
    expect(section).toHaveTextContent(
      "MCPJam’s fixed product fees and usage limits still apply",
    );
  });
});
