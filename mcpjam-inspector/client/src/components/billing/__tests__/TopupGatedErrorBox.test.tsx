import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { TopupGatedErrorBox } from "../TopupGatedErrorBox";

let presetsState:
  | Array<{
      packageId: string;
      priceCents: number;
      displayPrice: string;
      displayCredits: string;
    }>
  | undefined;
let presetsLoadingState: boolean;
let presetQueryShouldThrow = false;

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    isLoading: false,
    user: { id: "user-1" },
    signIn: vi.fn(),
  }),
}));

vi.mock("@/hooks/useCreditTopup", () => ({
  useCreditTopupPresets: ({ skip }: { skip?: boolean } = {}) => {
    if (skip) {
      return { presets: undefined, isLoading: false };
    }
    if (presetQueryShouldThrow) {
      throw new Error(
        "Could not find public function for 'billing:getCreditTopupPresets'"
      );
    }
    return { presets: presetsState, isLoading: presetsLoadingState };
  },
}));

// Note: rate-limit errors (`user_rate_limit` / `mcpjam_rate_limit`) are now
// owned by the global MCPJamLimitDialog modal — the inline ErrorBox returns
// null for them. We exercise TopupGatedErrorBox's CTA-gating logic against
// a non-rate-limit platform error so the inline banner is still rendered.
const RATE_LIMIT_PROPS = {
  message: "Provider unavailable. Try again later.",
  code: "provider_error",
  isRetryable: false,
  isMCPJamPlatformError: true,
  onResetChat: () => {},
};

describe("TopupGatedErrorBox", () => {
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
    presetsLoadingState = false;
    presetQueryShouldThrow = false;
  });

  it("does not render the Buy credits CTA when canTopUp is false", () => {
    render(
      <TopupGatedErrorBox
        {...RATE_LIMIT_PROPS}
        canTopUp={false}
        onTopUp={vi.fn()}
      />
    );
    expect(
      screen.queryByRole("button", { name: /Buy credits to keep chatting/ })
    ).not.toBeInTheDocument();
  });

  it("renders the Buy credits CTA when canTopUp is true and presets are available", () => {
    render(
      <TopupGatedErrorBox
        {...RATE_LIMIT_PROPS}
        canTopUp
        canManageCredits
        onTopUp={vi.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: /Buy credits to keep chatting/ })
    ).toBeInTheDocument();
  });

  it("shows the ask-admin hint instead of the Buy credits CTA when the user cannot manage credits", () => {
    render(
      <TopupGatedErrorBox
        {...RATE_LIMIT_PROPS}
        canTopUp
        canManageCredits={false}
        onTopUp={vi.fn()}
      />
    );
    expect(
      screen.queryByRole("button", { name: /Buy credits to keep chatting/ })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Ask org admin to top up credits/)
    ).toBeInTheDocument();
  });

  it("hides the Buy credits CTA when canTopUp is true but presets are empty", () => {
    presetsState = [];
    render(
      <TopupGatedErrorBox
        {...RATE_LIMIT_PROPS}
        canTopUp
        canManageCredits
        onTopUp={vi.fn()}
      />
    );
    expect(
      screen.queryByRole("button", { name: /Buy credits to keep chatting/ })
    ).not.toBeInTheDocument();
  });

  it("hides the Buy credits CTA while presets are still loading", () => {
    presetsState = undefined;
    presetsLoadingState = true;
    render(
      <TopupGatedErrorBox
        {...RATE_LIMIT_PROPS}
        canTopUp
        canManageCredits
        onTopUp={vi.fn()}
      />
    );
    expect(
      screen.queryByRole("button", { name: /Buy credits to keep chatting/ })
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
        canManageCredits
        onTopUp={vi.fn()}
      />
    );
    expect(
      screen.queryByRole("button", { name: /Buy credits to keep chatting/ })
    ).not.toBeInTheDocument();
    // The error copy is still rendered so the user understands what
    // happened, just without the gated Top-up CTA.
    expect(
      screen.getAllByText(/Provider unavailable/).length
    ).toBeGreaterThanOrEqual(1);
    errorSpy.mockRestore();
  });
});
