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
