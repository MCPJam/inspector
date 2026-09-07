import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WAITING IS NOT REFUSING.
 *
 * The section renders one of three things from this hook: a spinner, the
 * "personal organizations cannot set a spend budget" refusal, or the budget.
 * Picking between the first two is the whole job of `isLoading` and
 * `querySkipped`, and both directions have already been wrong once:
 *
 *   - reporting a skipped guest query as loading spun forever at the one
 *     audience with a real answer waiting;
 *   - reporting a still-settling actor as skipped told a real admin their
 *     organization was personal, which is a confident wrong answer and worse
 *     than the spinner it replaced.
 *
 * `useIsMemberActor` returns `undefined` while auth settles, so the
 * distinction rests on `isMember === false` rather than `!isMember`.
 */

const mocks = vi.hoisted(() => ({
  isMember: undefined as boolean | undefined,
  isUserReady: false,
  budget: undefined as unknown,
}));

vi.mock("convex/react", () => ({
  useQuery: () => mocks.budget,
  useMutation: () => vi.fn(),
}));

vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => mocks.isMember,
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => mocks.isUserReady,
}));

vi.mock("@/hooks/useOrgScopedWrite", () => ({
  useOrgScopedWrite: () => ({ error: null, isSaving: false, run: vi.fn() }),
}));

import { useOrgSpendBudget } from "../useOrgSpendBudget";

describe("useOrgSpendBudget — waiting vs refusing", () => {
  beforeEach(() => {
    mocks.isMember = undefined;
    mocks.isUserReady = false;
    mocks.budget = undefined;
  });

  it("waits while the actor is still settling", () => {
    // An ordinary hosted cold load. `undefined` is "we do not know yet",
    // never "not a member".
    mocks.isMember = undefined;
    const { result } = renderHook(() => useOrgSpendBudget("org_1"));
    expect(result.current.querySkipped).toBe(false);
    expect(result.current.isLoading).toBe(true);
  });

  it("waits while the database user is still bootstrapping", () => {
    // A known member whose row is not ready yet is still going to get an
    // answer; the query simply has not been allowed to run.
    mocks.isMember = true;
    mocks.isUserReady = false;
    const { result } = renderHook(() => useOrgSpendBudget("org_1"));
    expect(result.current.querySkipped).toBe(false);
    expect(result.current.isLoading).toBe(true);
  });

  it("refuses only once the actor is RESOLVED as a guest", () => {
    mocks.isMember = false;
    const { result } = renderHook(() => useOrgSpendBudget("org_1"));
    expect(result.current.querySkipped).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it("stops waiting once the budget arrives", () => {
    mocks.isMember = true;
    mocks.isUserReady = true;
    mocks.budget = { capCredits: null, supported: true };
    const { result } = renderHook(() => useOrgSpendBudget("org_1"));
    expect(result.current.querySkipped).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.budget).toEqual({
      capCredits: null,
      supported: true,
    });
  });
});
