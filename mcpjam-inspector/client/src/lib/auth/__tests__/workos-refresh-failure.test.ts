import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWorkosRefreshFailure } from "../workos-refresh-failure";

const mockState = vi.hoisted(() => ({
  reportCaught: vi.fn(),
}));

vi.mock("@/lib/error-reporting", () => ({
  reportCaught: mockState.reportCaught,
}));

describe("handleWorkosRefreshFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports one warning and sends the user to sign in", () => {
    const signIn = vi.fn();

    handleWorkosRefreshFailure({ signIn });

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(mockState.reportCaught).toHaveBeenCalledTimes(1);
    expect(mockState.reportCaught).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        source: "workos_refresh_failure",
        level: "warning",
      }),
    );
  });

  it("does not reject when signIn returns a rejected promise", () => {
    // The redirect is fire-and-forget; a failure to navigate must not surface
    // as an unhandled rejection inside authkit's callback.
    const signIn = vi.fn().mockRejectedValue(new Error("navigation blocked"));

    expect(() => handleWorkosRefreshFailure({ signIn })).not.toThrow();
    expect(signIn).toHaveBeenCalledTimes(1);
  });
});
