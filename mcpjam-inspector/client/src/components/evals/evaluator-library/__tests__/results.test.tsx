import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { CandidateRow, maskCandidate } from "../candidate-row";

describe("maskCandidate", () => {
  it("keeps short values and truncates long ones after 12 characters", () => {
    expect(maskCandidate("test@ex.com")).toBe("test@ex.com");
    expect(maskCandidate("sk_live_51HxAbCdEfGhQm2a")).toBe("sk_live_51Hx…");
  });
});

describe("CandidateRow", () => {
  it("masks a confirmed secret and shows the model's answer", () => {
    renderWithProviders(
      <CandidateRow
        kind="Stripe secret key"
        value="sk_live_51HxAbCdEfGhQm2a"
        location="get_order result · payment.processor_key"
        verdict="confirmed"
        probability={0.97}
      />,
    );
    expect(screen.getByText("sk_live_51Hx…")).toBeInTheDocument();
    expect(screen.queryByText(/AbCdEf/)).not.toBeInTheDocument();
    expect(screen.getByText("Real")).toBeInTheDocument();
    expect(screen.getByText("Yes · 0.97")).toBeInTheDocument();
    expect(
      screen.getByRole("meter", { name: "Probability this is real" }),
    ).toHaveAttribute("aria-valuenow", "0.97");
  });

  it("shows an allowed value without a model answer", () => {
    renderWithProviders(
      <CandidateRow
        kind="Email address"
        value="jordan@example.com"
        location="get_order result · shipping.email"
        verdict="allowed"
      />,
    );
    expect(screen.getByText("Allowed by case")).toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });
});
