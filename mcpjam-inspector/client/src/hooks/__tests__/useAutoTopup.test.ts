import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isMember: undefined as boolean | undefined,
  isUserReady: false,
  raw: undefined as unknown,
  set: vi.fn(),
  clear: vi.fn(),
}));
const queryArgs = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (_name: string, args: unknown) => {
    queryArgs(args);
    return mocks.raw;
  },
  useMutation: (name: string) =>
    name.endsWith("clearOrganizationAutoTopup") ? mocks.clear : mocks.set,
}));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => mocks.isMember,
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => mocks.isUserReady,
}));
vi.mock("@/hooks/useOrgScopedWrite", () => ({
  useOrgScopedWrite: () => ({
    error: null,
    isSaving: false,
    run: (work: () => Promise<unknown>) => work(),
  }),
}));

import { normalizeAutoTopup, useAutoTopup } from "../useAutoTopup";

describe("useAutoTopup", () => {
  beforeEach(() => {
    mocks.isMember = undefined;
    mocks.isUserReady = false;
    mocks.raw = undefined;
    mocks.set.mockReset();
    mocks.clear.mockReset();
    queryArgs.mockClear();
  });
  const lastQueryArg = () => queryArgs.mock.calls.at(-1)?.[0];

  it("waits, and does not query, while the actor is still settling", () => {
    const { result } = renderHook(() => useAutoTopup("org_1"));
    expect(lastQueryArg()).toBe("skip");
    expect(result.current.isLoading).toBe(true);
    expect(result.current.querySkipped).toBe(false);
  });
  it("skips a resolved guest instead of spinning", () => {
    mocks.isMember = false;
    mocks.isUserReady = true;
    const { result } = renderHook(() => useAutoTopup("org_1"));
    expect(lastQueryArg()).toBe("skip");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.querySkipped).toBe(true);
  });
  it("queries for a ready member and normalizes the row", async () => {
    mocks.isMember = true;
    mocks.isUserReady = true;
    mocks.raw = { thresholdCredits: 100, topupCredits: 500, extra: 1 };
    const { result } = renderHook(() => useAutoTopup("org_1"));
    expect(lastQueryArg()).toEqual({ organizationId: "org_1" });
    expect(result.current.enrollment).toEqual({
      thresholdCredits: 100,
      topupCredits: 500,
      monthlySpendLimitCredits: null,
    });
    await result.current.save({
      thresholdCredits: 200,
      topupCredits: 1000,
      monthlySpendLimitCredits: 5000,
    });
    expect(mocks.set).toHaveBeenCalledWith({
      organizationId: "org_1",
      thresholdCredits: 200,
      topupCredits: 1000,
      monthlySpendLimitCredits: 5000,
    });
    await result.current.disable();
    expect(mocks.clear).toHaveBeenCalledWith({ organizationId: "org_1" });
  });
  it("treats null and malformed rows as not enrolled", () => {
    expect(normalizeAutoTopup(undefined)).toBeUndefined();
    expect(normalizeAutoTopup(null)).toBeNull();
    expect(normalizeAutoTopup({ thresholdCredits: "100" })).toBeNull();
  });
});
