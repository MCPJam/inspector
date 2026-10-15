import { renderHook } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  result: undefined as unknown,
  requests: [] as Array<Record<string, { query: any; args: unknown }>>,
}));

vi.mock("convex/react", () => ({
  useQueries: (queries: Record<string, { query: any; args: unknown }>) => {
    mockState.requests.push(queries);
    return "result" in queries ? { result: mockState.result } : {};
  },
}));

import { useSoftQuery } from "../use-soft-query";

describe("useSoftQuery", () => {
  beforeEach(() => {
    mockState.result = undefined;
    mockState.requests = [];
  });

  it("subscribes to the named query with its arguments", () => {
    mockState.result = { plan: "team" };

    const { result } = renderHook(() =>
      useSoftQuery("billing:getOrganizationBillingStatus", {
        organizationId: "org-1",
      }),
    );

    const request = mockState.requests.at(-1)!.result;
    expect(getFunctionName(request.query)).toBe(
      "billing:getOrganizationBillingStatus",
    );
    expect(request.args).toEqual({ organizationId: "org-1" });
    expect(result.current).toEqual({
      data: { plan: "team" },
      error: undefined,
    });
  });

  // The point of the hook: `useQuery` would throw this during render, and from
  // the app shell that replaces every page with the route error screen.
  it("returns a server error instead of throwing it", () => {
    const failure = new Error(
      "[CONVEX Q(billing:getCreditBalance)] Server Error",
    );
    mockState.result = failure;

    const { result } = renderHook(() =>
      useSoftQuery("billing:getCreditBalance", {}),
    );

    expect(result.current).toEqual({ data: undefined, error: failure });
  });

  it("reads as pending, not failed, while the answer is in flight", () => {
    const { result } = renderHook(() =>
      useSoftQuery("billing:getCreditBalance", {}),
    );

    expect(result.current).toEqual({ data: undefined, error: undefined });
  });

  it("opens no subscription when skipped", () => {
    mockState.result = { plan: "team" };

    const { result } = renderHook(() =>
      useSoftQuery("billing:getOrganizationBillingStatus", "skip"),
    );

    expect(mockState.requests.at(-1)).toEqual({});
    expect(result.current).toEqual({ data: undefined, error: undefined });
  });

  // Convex keys a subscription by the request object's identity, so a new
  // object on every render would resubscribe on every render.
  it("keeps the request object stable while the arguments are equal", () => {
    const { rerender } = renderHook(
      ({ organizationId }) =>
        useSoftQuery("billing:getEvalIterationQuota", { organizationId }),
      { initialProps: { organizationId: "org-1" } },
    );
    rerender({ organizationId: "org-1" });
    const [first, second] = mockState.requests.slice(-2);
    expect(second).toBe(first);

    rerender({ organizationId: "org-2" });
    const third = mockState.requests.at(-1)!;
    expect(third).not.toBe(first);
    expect(third.result.args).toEqual({ organizationId: "org-2" });
  });

  it("drops undefined arguments, as Convex does", () => {
    renderHook(() =>
      useSoftQuery("billing:getOrganizationBillingBundle", {
        organizationId: "org-1",
        projectId: undefined,
      }),
    );

    expect(mockState.requests.at(-1)!.result.args).toEqual({
      organizationId: "org-1",
    });
  });
});
