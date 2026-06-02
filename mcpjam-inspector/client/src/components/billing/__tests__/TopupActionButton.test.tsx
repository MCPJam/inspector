import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TopupActionButton } from "../TopupActionButton";

let presetsState:
  | Array<{
      packageId: string;
      priceCents: number;
      displayPrice: string;
      displayCredits: string;
    }>
  | undefined;

vi.mock("@/hooks/useCreditTopup", () => ({
  useCreditTopupPresets: () => ({
    presets: presetsState,
    isLoading: presetsState === undefined,
  }),
}));

describe("TopupActionButton", () => {
  beforeEach(() => {
    presetsState = [
      {
        packageId: "credits_500",
        priceCents: 500,
        displayPrice: "$5",
        displayCredits: "500 credits",
      },
      {
        packageId: "credits_1000",
        priceCents: 1000,
        displayPrice: "$10",
        displayCredits: "1,000 credits",
      },
      {
        packageId: "credits_2000",
        priceCents: 2000,
        displayPrice: "$20",
        displayCredits: "2,000 credits",
      },
    ];
  });

  it("renders the Buy credits button when presets are available", () => {
    render(<TopupActionButton onClick={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Buy credits" })
    ).toBeInTheDocument();
  });

  it("renders nothing while presets are loading", () => {
    presetsState = undefined;
    const { container } = render(<TopupActionButton onClick={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when presets resolve to an empty list", () => {
    presetsState = [];
    const { container } = render(<TopupActionButton onClick={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("calls onClick when the button is clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<TopupActionButton onClick={onClick} />);
    await user.click(screen.getByRole("button", { name: "Buy credits" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
