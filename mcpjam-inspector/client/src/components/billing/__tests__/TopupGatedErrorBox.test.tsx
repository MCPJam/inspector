import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { TopupGatedErrorBox } from "../TopupGatedErrorBox";

let presetsState: Array<{ amountCents: number; amountUsd: string }> | undefined;
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
        "Could not find public function for 'billing:getCreditTopupPresets'",
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
    // The error copy is still rendered so the user understands what
    // happened, just without the gated Top-up CTA.
    expect(
      screen.getAllByText(/Provider unavailable/).length,
    ).toBeGreaterThanOrEqual(1);
    errorSpy.mockRestore();
  });
});
