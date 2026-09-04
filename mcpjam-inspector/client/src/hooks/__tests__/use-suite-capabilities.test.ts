/**
 * The capabilities read is allowed to FAIL, and failing must cost nothing.
 *
 * Two ordinary failures reach this hook: a deployment that predates the query
 * (the inspector and the backend release independently), and a caller the
 * backend answers `null` for — its 404-never-403 shape for a suite this person
 * cannot see. Neither is a fault, and neither may take a page down.
 *
 * `useQuery` would: it re-throws during render, which is why this hook reads
 * through `useConvex().query` inside an effect instead. That choice is the
 * thing these tests pin — a refactor back to `useQuery` fails here rather than
 * in production, where it has already once taken `/evals` down for every user
 * a gate refused.
 */

import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const queryMock = vi.fn();
// ONE stable client, as `useConvex` really returns. A fresh object per render
// would make the hook's effect dependency change every render — which is not
// what the app does, and would test a loop nobody has.
const convexClient = { query: queryMock };
vi.mock("convex/react", () => ({
  useConvex: () => convexClient,
}));

import { useSuiteCapabilities } from "../use-suite-capabilities";

describe("useSuiteCapabilities", () => {
  it("reports `unavailable` when the backend answers null", async () => {
    queryMock.mockResolvedValue(null);
    const { result } = renderHook(() => useSuiteCapabilities("suite-1"));
    await waitFor(() => expect(result.current.state).toBe("unavailable"));
    expect(result.current.capabilities).toBeNull();
  });

  it("reports `unavailable` when the query throws, without re-throwing", async () => {
    queryMock.mockRejectedValue(
      new Error(
        "Could not find public function for 'testSuites:getSuiteCapabilities'",
      ),
    );
    const { result } = renderHook(() => useSuiteCapabilities("suite-1"));
    await waitFor(() => expect(result.current.state).toBe("unavailable"));
    expect(result.current.capabilities).toBeNull();
  });

  it("passes a resolved answer through unchanged", async () => {
    const capabilities = {
      suiteId: "suite-1",
      organizationId: "org-1",
      permissions: { "suite.delete": false },
      features: { computers: { enabled: false, reason: "flag_false" } },
      verdictPolicyV2: {
        deploymentMode: "enforce",
        suiteMode: null,
        canUpgrade: true,
      },
      judge: {
        gating: { enabled: false, reason: "not_enabled_on_deployment" },
        role: "advisory",
        hasRubric: false,
        agreement: { reviews: 0, agreements: 0, rate: null },
        acknowledgement: null,
      },
      revisionNumber: 4,
    };
    queryMock.mockResolvedValue(capabilities);
    const { result } = renderHook(() => useSuiteCapabilities("suite-1"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    // Passed through, not reshaped. Anything this hook computed would be a
    // second opinion about a question the backend already answered.
    expect(result.current.capabilities).toEqual(capabilities);
  });

  it("does not ask at all without a suite", async () => {
    queryMock.mockClear();
    const { result } = renderHook(() => useSuiteCapabilities(null));
    await waitFor(() => expect(result.current.state).toBe("unavailable"));
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("re-asks when the refresh key moves", async () => {
    queryMock.mockClear();
    queryMock.mockResolvedValue(null);
    const { rerender } = renderHook(
      ({ key }: { key: number }) => useSuiteCapabilities("suite-1", key),
      { initialProps: { key: 1 } },
    );
    await waitFor(() => expect(queryMock).toHaveBeenCalledTimes(1));
    rerender({ key: 2 });
    // A save that changes what someone may do next has to change the rows,
    // not leave them describing the suite as it was when the page loaded.
    await waitFor(() => expect(queryMock).toHaveBeenCalledTimes(2));
  });
});
