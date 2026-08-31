import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describeAsSlug } from "@mcpjam/sdk/browser";
import { ErrorCard } from "../error-card";

/**
 * The heading is a claim about how much we know. A catalog entry carrying one
 * cause means the state is established, and labelling that "Likely causes"
 * reads as the product being unsure whether the account is out of allowance —
 * which is what it was reported for.
 */
describe("ErrorCard cause heading", () => {
  const openDetails = () => fireEvent.click(screen.getByText("Show details"));

  it("states the cause outright when the catalog carries exactly one", () => {
    render(
      <ErrorCard
        error={describeAsSlug("provider/mcpjam_limit_daily", new Error("x"))}
      />,
    );
    openDetails();

    expect(screen.getByText("Why this happened")).toBeInTheDocument();
    expect(screen.queryByText("Likely causes")).not.toBeInTheDocument();
  });

  it("keeps the hedge where the wire genuinely does not settle it", () => {
    render(
      <ErrorCard
        error={describeAsSlug("transport/econnrefused", new Error("x"))}
      />,
    );
    openDetails();

    expect(screen.getByText("Likely causes")).toBeInTheDocument();
    expect(screen.queryByText("Why this happened")).not.toBeInTheDocument();
  });
});
