import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock convex/react so importing the hook module doesn't require a
// provider — we only exercise the pure helpers (URL guard + sessionStorage
// peek/clear), not the React hooks.
vi.mock("convex/react", () => ({
  useAction: () => () => Promise.resolve(null),
  useQuery: () => undefined,
}));

import {
  clearPendingTopup,
  isAllowedCheckoutUrl,
  peekPendingTopup,
  stashPendingTopup,
} from "../useCreditTopup";

describe("isAllowedCheckoutUrl", () => {
  it("accepts a real-looking Stripe Checkout URL", () => {
    expect(
      isAllowedCheckoutUrl(
        "https://checkout.stripe.com/c/pay/cs_test_a1b2c3d4e5",
      ),
    ).toBe(true);
  });

  it("rejects a different host even if the path looks like Stripe's", () => {
    expect(
      isAllowedCheckoutUrl("https://evil.example/c/pay/cs_test_a1b2c3d4e5"),
    ).toBe(false);
  });

  it("rejects a hostname-prefix attack", () => {
    expect(
      isAllowedCheckoutUrl(
        "https://checkout.stripe.com.evil.example/cs_test_xyz",
      ),
    ).toBe(false);
  });

  it("rejects http-only Stripe URLs", () => {
    expect(isAllowedCheckoutUrl("http://checkout.stripe.com/cs_test_xyz")).toBe(
      false,
    );
  });

  it("rejects javascript: / data: schemes", () => {
    expect(isAllowedCheckoutUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedCheckoutUrl("data:text/html,<script>")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isAllowedCheckoutUrl(undefined)).toBe(false);
    expect(isAllowedCheckoutUrl(null)).toBe(false);
    expect(isAllowedCheckoutUrl(42)).toBe(false);
    expect(isAllowedCheckoutUrl({})).toBe(false);
  });
});

describe("peekPendingTopup / clearPendingTopup", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.sessionStorage.clear();
  });

  it("returns null when nothing is stashed", () => {
    expect(peekPendingTopup()).toBeNull();
  });

  it("returns a freshly stashed entry without removing it", () => {
    stashPendingTopup({ chatSessionId: "chat-1", message: "hi" });
    const first = peekPendingTopup();
    expect(first).not.toBeNull();
    expect(first?.chatSessionId).toBe("chat-1");
    expect(first?.message).toBe("hi");

    // Critically: the entry should still be there after a peek.
    const second = peekPendingTopup();
    expect(second).not.toBeNull();
    expect(second?.message).toBe("hi");
  });

  it("returns null and clears the entry when expired (>10 min old)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T12:00:00Z"));
    stashPendingTopup({ chatSessionId: "chat-1", message: "hi" });

    // Jump 11 minutes ahead — past the 10-min TTL.
    vi.setSystemTime(new Date("2026-04-30T12:11:00Z"));
    expect(peekPendingTopup()).toBeNull();

    // After expiry the entry is gone, even on a second peek.
    expect(window.sessionStorage.getItem("mcpjam.topup.pending")).toBeNull();
  });

  it("returns null and clears the entry when malformed", () => {
    window.sessionStorage.setItem("mcpjam.topup.pending", "{not json");
    expect(peekPendingTopup()).toBeNull();
    expect(window.sessionStorage.getItem("mcpjam.topup.pending")).toBeNull();
  });

  it("returns null and clears the entry when shape is wrong", () => {
    window.sessionStorage.setItem(
      "mcpjam.topup.pending",
      JSON.stringify({ chatSessionId: 42, message: null }),
    );
    expect(peekPendingTopup()).toBeNull();
    expect(window.sessionStorage.getItem("mcpjam.topup.pending")).toBeNull();
  });

  it("clearPendingTopup removes a valid entry", () => {
    stashPendingTopup({ chatSessionId: "chat-1", message: "hi" });
    expect(peekPendingTopup()).not.toBeNull();
    clearPendingTopup();
    expect(peekPendingTopup()).toBeNull();
    expect(window.sessionStorage.getItem("mcpjam.topup.pending")).toBeNull();
  });

  it("does not stash when chatSessionId or message is empty", () => {
    stashPendingTopup({ chatSessionId: "", message: "hi" });
    expect(peekPendingTopup()).toBeNull();
    stashPendingTopup({ chatSessionId: "chat-1", message: "" });
    expect(peekPendingTopup()).toBeNull();
    stashPendingTopup({ chatSessionId: "", message: "" });
    expect(peekPendingTopup()).toBeNull();
  });
});
