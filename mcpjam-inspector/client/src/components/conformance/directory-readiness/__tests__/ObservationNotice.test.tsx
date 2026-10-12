import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AI_UNAVAILABLE_OBSERVATIONS,
  ObservationNotice,
} from "../ObservationNotice";

describe("ObservationNotice — organization AI-key policy", () => {
  it("says the organization's configuration, not credits, stopped the observations", () => {
    render(
      <ObservationNotice
        observations={{ status: "ai-unavailable", reason: "ai_unavailable" }}
      />,
    );
    expect(screen.getByText(AI_UNAVAILABLE_OBSERVATIONS)).toBeInTheDocument();
    expect(screen.queryByText(/billing|credits|model limit/i)).toBeNull();
  });

  it("reads the reason even under a status an older union lacks", () => {
    render(
      <ObservationNotice
        observations={{ status: "billing-blocked", reason: "ai_unavailable" }}
      />,
    );
    expect(screen.getByText(AI_UNAVAILABLE_OBSERVATIONS)).toBeInTheDocument();
  });

  it("keeps the billing copy for a billing refusal", () => {
    render(
      <ObservationNotice
        observations={{
          status: "billing-blocked",
          reason: "billing_limit_reached",
        }}
      />,
    );
    expect(
      screen.getByText(/reached its MCPJam model limit/i),
    ).toBeInTheDocument();
  });
});
