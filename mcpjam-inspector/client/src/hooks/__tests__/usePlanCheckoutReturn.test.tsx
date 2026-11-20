import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const { toastSuccessMock } = vi.hoisted(() => ({ toastSuccessMock: vi.fn() }));

vi.mock("sonner", () => ({
  toast: { success: toastSuccessMock, error: vi.fn() },
}));

import {
  PLAN_CHECKOUT_SUCCESS_MESSAGE,
  usePlanCheckoutReturn,
} from "../usePlanCheckoutReturn";

function visit(search: string) {
  window.history.replaceState(null, "", `/organizations/org_1/plans${search}`);
}

afterEach(() => {
  toastSuccessMock.mockReset();
  window.history.replaceState(null, "", "/");
});

describe("usePlanCheckoutReturn", () => {
  it("tells the person to go back to their agent after an upgrade", () => {
    visit("?plan_checkout=success&tab=plans");
    renderHook(() => usePlanCheckoutReturn());
    expect(toastSuccessMock).toHaveBeenCalledWith(
      PLAN_CHECKOUT_SUCCESS_MESSAGE,
    );
    // The marker is cleared, other params kept, so a reload says nothing.
    expect(window.location.search).toBe("?tab=plans");
  });

  it("says nothing on a return without the success marker", () => {
    visit("?tab=plans");
    renderHook(() => usePlanCheckoutReturn());
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?tab=plans");
  });
});
