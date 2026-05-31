import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TopupActionButton } from "../TopupActionButton";

let presetsState: Array<{ amountCents: number; amountUsd: string }> | undefined;

vi.mock("@/hooks/useCreditTopup", () => ({
  useCreditTopupPresets: () => ({
    presets: presetsState,
    isLoading: presetsState === undefined,
  }),
}));

describe("TopupActionButton", () => {
  beforeEach(() => {
    presetsState = [
      { amountCents: 500, amountUsd: "$5" },
      { amountCents: 1000, amountUsd: "$10" },
      { amountCents: 2000, amountUsd: "$20" },
    ];
  });

  it("renders the Top up button when presets are available", () => {
    render(<TopupActionButton onClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Top up" })).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Top up" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
