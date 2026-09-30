import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const createCheckoutSession = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());

vi.mock("convex/react", () => ({
  useAction: () => createCheckoutSession,
  useQuery: () => undefined,
}));

vi.mock("@/lib/toast", () => ({
  toast: { info: toastInfo, error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { useCreditTopup } from "../useCreditTopup";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_a1b2c3";

function startCheckoutArgs() {
  return {
    organizationId: "org-1",
    packageId: "credits_1000",
    priceCents: 1000,
    chatSessionId: "chat-1",
    lastUserMessage: "hello",
    source: "billing_page" as const,
  };
}

describe("useCreditTopup startCheckout", () => {
  beforeEach(() => {
    createCheckoutSession.mockReset();
    createCheckoutSession.mockResolvedValue({ checkoutUrl: CHECKOUT_URL });
    toastInfo.mockReset();
  });

  afterEach(() => {
    delete (window as { isElectron?: boolean }).isElectron;
    useMCPJamLimitDialogStore.setState(
      useMCPJamLimitDialogStore.getInitialState(),
    );
  });

  it("navigates in place in the browser", async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, href: original.href, assign },
    });

    try {
      const { result } = renderHook(() => useCreditTopup());
      let outcome: Awaited<ReturnType<typeof result.current.startCheckout>>;
      await act(async () => {
        outcome = await result.current.startCheckout(startCheckoutArgs());
      });

      expect(assign).toHaveBeenCalledWith(CHECKOUT_URL);
      expect(outcome!).toEqual({ handedOffToBrowser: false });
      expect(toastInfo).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: original,
      });
    }
  });

  it("hands checkout to the browser on desktop instead of navigating in place", async () => {
    // The shell routes cross-origin navigation to the system browser, so
    // `location.assign` moves nothing and the dialog would sit over a page
    // that never leaves.
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, href: original.href, assign },
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    (window as { isElectron?: boolean }).isElectron = true;

    try {
      const { result } = renderHook(() => useCreditTopup());
      let outcome: Awaited<ReturnType<typeof result.current.startCheckout>>;
      await act(async () => {
        outcome = await result.current.startCheckout(startCheckoutArgs());
      });

      expect(openSpy).toHaveBeenCalledWith(
        CHECKOUT_URL,
        "_blank",
        "noopener,noreferrer",
      );
      expect(assign).not.toHaveBeenCalled();
      expect(outcome!).toEqual({ handedOffToBrowser: true });
      expect(toastInfo).toHaveBeenCalledWith(
        "Finish checkout in your browser. Your credits appear here automatically.",
      );
    } finally {
      openSpy.mockRestore();
      Object.defineProperty(window, "location", {
        configurable: true,
        value: original,
      });
    }
  });

  it("refuses a non-Stripe checkout URL on desktop too", async () => {
    createCheckoutSession.mockResolvedValue({
      checkoutUrl: "https://evil.example/c/pay/cs_test_x",
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    (window as { isElectron?: boolean }).isElectron = true;

    try {
      const { result } = renderHook(() => useCreditTopup());
      await act(async () => {
        await expect(
          result.current.startCheckout(startCheckoutArgs()),
        ).rejects.toThrow(/The payment link couldn’t be verified/);
      });
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("makes the swarm waves announced so far news again once a purchase starts", async () => {
    // The desktop app stays open while the browser handles checkout, and a
    // retried launch reuses its wave: a run that runs out again after paying
    // has to be able to reopen the dialog.
    useMCPJamLimitDialogStore.setState({
      notifiedKeys: new Set(["run:run-a", "wave:wave-1"]),
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    (window as { isElectron?: boolean }).isElectron = true;

    try {
      const { result } = renderHook(() => useCreditTopup());
      await act(async () => {
        await result.current.startCheckout(startCheckoutArgs());
      });

      const state = useMCPJamLimitDialogStore.getState();
      expect(state.staleWaveKeys).toEqual(new Set(["wave:wave-1"]));
      // Forgotten as current, not as known: a replay of run-a stays a no-op.
      expect(state.notifiedKeys).toEqual(new Set(["run:run-a", "wave:wave-1"]));
    } finally {
      openSpy.mockRestore();
    }
  });

  it("leaves the announced waves alone when the checkout never opens", async () => {
    createCheckoutSession.mockResolvedValue({
      checkoutUrl: "https://evil.example/c/pay/cs_test_x",
    });
    useMCPJamLimitDialogStore.setState({
      notifiedKeys: new Set(["run:run-a", "wave:wave-1"]),
    });

    const { result } = renderHook(() => useCreditTopup());
    await act(async () => {
      await expect(
        result.current.startCheckout(startCheckoutArgs()),
      ).rejects.toThrow(/The payment link couldn’t be verified/);
    });

    expect(useMCPJamLimitDialogStore.getState().staleWaveKeys).toEqual(
      new Set(),
    );
  });
});
