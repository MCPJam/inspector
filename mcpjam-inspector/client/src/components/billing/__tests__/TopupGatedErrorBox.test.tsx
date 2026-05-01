import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { TopupGatedErrorBox } from "../TopupGatedErrorBox";

let presetsState: Array<{ amountCents: number; amountUsd: string }> | undefined;
let presetsLoadingState: boolean;
let presetQueryShouldThrow = false;

vi.mock("@/hooks/useCreditTopup", () => ({
  useCreditTopupPresets: ({ skip }: { skip?: boolean } = {}) => {
    if (skip) {
      return { presets: undefined, isLoading: false };
    }
    if (presetQueryShouldThrow) {
      throw new Error(
        "Could not find public function for 'billing:getCreditTopupPresets'",
      );
    }
    return { presets: presetsState, isLoading: presetsLoadingState };
  },
}));

const RATE_LIMIT_PROPS = {
  message: "Daily MCPJam model limit reached.",
  code: "user_rate_limit",
  isRetryable: false,
  isMCPJamPlatformError: true,
  onResetChat: () => {},
};

describe("TopupGatedErrorBox", () => {
  beforeEach(() => {
    presetsState = [
      { amountCents: 500, amountUsd: "$5" },
      { amountCents: 1000, amountUsd: "$10" },
      { amountCents: 2000, amountUsd: "$20" },
    ];
    presetsLoadingState = false;
    presetQueryShouldThrow = false;
  });

  it("does not render the Top up CTA when canTopUp is false", () => {
    render(
      <TopupGatedErrorBox
        {...RATE_LIMIT_PROPS}
        canTopUp={false}
        onTopUp={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Top up to keep chatting/ }),
    ).not.toBeInTheDocument();
  });

  it("renders the Top up CTA when canTopUp is true and presets are available", () => {
    render(
      <TopupGatedErrorBox
        {...RATE_LIMIT_PROPS}
        canTopUp
        onTopUp={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Top up to keep chatting/ }),
    ).toBeInTheDocument();
  });

  it("hides the Top up CTA when canTopUp is true but presets are empty", () => {
    presetsState = [];
    render(
      <TopupGatedErrorBox
        {...RATE_LIMIT_PROPS}
        canTopUp
        onTopUp={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Top up to keep chatting/ }),
    ).not.toBeInTheDocument();
  });

  it("hides the Top up CTA while presets are still loading", () => {
    presetsState = undefined;
    presetsLoadingState = true;
    render(
      <TopupGatedErrorBox
        {...RATE_LIMIT_PROPS}
        canTopUp
        onTopUp={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Top up to keep chatting/ }),
    ).not.toBeInTheDocument();
  });

  it("falls back to a plain ErrorBox when the preset query throws", () => {
    presetQueryShouldThrow = true;
    // Suppress React's expected error log noise from the boundary catch.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <TopupGatedErrorBox
        {...RATE_LIMIT_PROPS}
        canTopUp
        onTopUp={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Top up to keep chatting/ }),
    ).not.toBeInTheDocument();
    // The rate-limit copy is still rendered so the user understands what
    // happened. ("Daily MCPJam model limit reached" appears in both the
    // header label and the message body, so use getAllByText.)
    expect(
      screen.getAllByText(/Daily MCPJam model limit reached/).length,
    ).toBeGreaterThanOrEqual(1);
    errorSpy.mockRestore();
  });
});
