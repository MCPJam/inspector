/**
 * Who is asking, versus what is deployed.
 *
 * `useRunInsights` auto-requests narration once per cohort. On a guest-visible
 * surface that auto-request can be refused for permissions, and
 * `usePromoteCapability` answers `true` for an anonymous hosted visitor — so
 * the caller's `canRequest` gate does NOT stop it. These pin the narrow latch
 * that does: a permission refusal suppresses further AUTO-requests, an
 * explicit press clears it (the viewer may have signed in since), and it never
 * marks the feature unavailable the way a missing backend function does.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRunInsights, type RunInsightsScope } from "@/hooks/use-run-insights";

const { state } = vi.hoisted(() => ({
  state: { requestMock: vi.fn() },
}));

vi.mock("convex/react", () => ({
  // Never requested for this cohort — the precondition for auto-request.
  useQuery: () => null,
  useMutation: (name: string) =>
    name.includes("requestWindowInsights") ? state.requestMock : vi.fn(),
}));

const SCOPE_A: RunInsightsScope = {
  kind: "chatbox",
  chatboxId: "cb-1",
  groupId: "g-1",
};
const SCOPE_B: RunInsightsScope = {
  kind: "chatbox",
  chatboxId: "cb-2",
  groupId: "g-2",
};
const SCOPE_C: RunInsightsScope = {
  kind: "chatbox",
  chatboxId: "cb-3",
  groupId: "g-3",
};

beforeEach(() => {
  state.requestMock.mockReset();
});

describe("useRunInsights permission refusals", () => {
  it("stops auto-requesting for the rest of the session once refused", async () => {
    state.requestMock.mockRejectedValue(
      new Error("Not a member of this workspace"),
    );
    const { result, rerender } = renderHook(
      ({ scope }: { scope: RunInsightsScope }) =>
        useRunInsights(scope, { terminal: true }),
      { initialProps: { scope: SCOPE_A } },
    );

    await waitFor(() => expect(state.requestMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.error).toBe(
        "Ask a workspace member to generate insights.",
      ),
    );
    // A refusal is not an undeployed backend: the surface stays visible.
    expect(result.current.unavailable).toBe(false);

    // Navigating to another scenario must not re-fire the doomed request.
    rerender({ scope: SCOPE_B });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.requestMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a cohort's rejection once the user has navigated on", async () => {
    // Cohort state belongs to the cohort that asked for it: a late answer for
    // the scenario the user just left must not paint an error — or hide the
    // surface — over the one now on screen.
    let rejectA: ((err: unknown) => void) | undefined;
    state.requestMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectA = reject;
        }),
    );
    const { result, rerender } = renderHook(
      ({ scope }: { scope: RunInsightsScope }) =>
        useRunInsights(scope, { terminal: true }),
      { initialProps: { scope: SCOPE_A } },
    );
    await waitFor(() => expect(state.requestMock).toHaveBeenCalledTimes(1));

    state.requestMock.mockResolvedValue(undefined);
    rerender({ scope: SCOPE_B });
    await waitFor(() => expect(state.requestMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      rejectA?.(new Error("Server Error: uncaught exception"));
      await Promise.resolve();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.unavailable).toBe(false);
  });

  it("latches a refusal that lands after the viewer moved on", async () => {
    // Navigating does not change who is asking. If the refusal only counted
    // while its own cohort was still on screen, a guest browsing scenarios
    // would out-run it and fire a doomed request on every one.
    let rejectA: ((err: unknown) => void) | undefined;
    state.requestMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectA = reject;
        }),
    );
    const { rerender } = renderHook(
      ({ scope }: { scope: RunInsightsScope }) =>
        useRunInsights(scope, { terminal: true }),
      { initialProps: { scope: SCOPE_A } },
    );
    await waitFor(() => expect(state.requestMock).toHaveBeenCalledTimes(1));

    state.requestMock.mockImplementation(() => new Promise(() => {}));
    rerender({ scope: SCOPE_B });
    await waitFor(() => expect(state.requestMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      rejectA?.(new Error("Insufficient workspace permissions"));
      await Promise.resolve();
    });

    rerender({ scope: SCOPE_C });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.requestMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a superseded attempt on the same cohort", async () => {
    // Two requests in flight for one cohort: the older one's rejection must
    // not report failure — or clear the busy flag — for the newer one.
    let rejectFirst: ((err: unknown) => void) | undefined;
    state.requestMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const { result } = renderHook(() =>
      useRunInsights(SCOPE_A, { terminal: true }),
    );
    await waitFor(() => expect(state.requestMock).toHaveBeenCalledTimes(1));

    state.requestMock.mockImplementationOnce(() => new Promise(() => {}));
    act(() => result.current.request(true));
    await waitFor(() => expect(state.requestMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      rejectFirst?.(new Error("wave_too_large"));
      await Promise.resolve();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(true);
  });

  it("does not re-latch from an attempt the user's retry superseded", async () => {
    // The retry asserts a possibly-new identity. A refusal answering the
    // attempt before it must not restore the latch behind that assertion.
    let rejectAuto: ((err: unknown) => void) | undefined;
    state.requestMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectAuto = reject;
        }),
    );
    const { result, rerender } = renderHook(
      ({ scope }: { scope: RunInsightsScope }) =>
        useRunInsights(scope, { terminal: true }),
      { initialProps: { scope: SCOPE_A } },
    );
    await waitFor(() => expect(state.requestMock).toHaveBeenCalledTimes(1));

    state.requestMock.mockResolvedValue(undefined);
    act(() => result.current.request());
    await waitFor(() => expect(state.requestMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      rejectAuto?.(new Error("Not a member of this workspace"));
      await Promise.resolve();
    });

    // Not latched: the next cohort still auto-requests.
    rerender({ scope: SCOPE_B });
    await waitFor(() => expect(state.requestMock).toHaveBeenCalledTimes(3));
  });

  it("lets an explicit press try again — the viewer may have signed in", async () => {
    state.requestMock.mockRejectedValue(
      new Error("Insufficient workspace permissions"),
    );
    const { result } = renderHook(() =>
      useRunInsights(SCOPE_A, { terminal: true }),
    );
    await waitFor(() => expect(state.requestMock).toHaveBeenCalledTimes(1));

    state.requestMock.mockResolvedValue(undefined);
    act(() => result.current.request());
    await waitFor(() => expect(state.requestMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.error).toBeNull());
  });
});
