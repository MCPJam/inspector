import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const softQueryMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-soft-query", () => ({
  useSoftQuery: (...args: unknown[]) => softQueryMock(...args),
}));

import {
  nativeHarnessTurnsLeftPercent,
  nativeHarnessTurnsLeftText,
  useNativeHarnessTrial,
} from "../use-native-harness-trial";

beforeEach(() => {
  softQueryMock.mockReset();
  softQueryMock.mockReturnValue({ data: undefined, error: undefined });
});

describe("useNativeHarnessTrial", () => {
  it("reads the organization's trial", () => {
    softQueryMock.mockReturnValue({
      data: { applies: true, granted: 20, used: 8, remaining: 12 },
      error: undefined,
    });
    const { result } = renderHook(() => useNativeHarnessTrial("org_1"));

    expect(result.current).toEqual({ remaining: 12, granted: 20 });
    expect(softQueryMock).toHaveBeenCalledWith("nativeHarnessTrial:get", {
      organizationId: "org_1",
    });
  });

  it("is null for a paid plan, while loading and when the read fails", () => {
    softQueryMock.mockReturnValue({
      data: { applies: false, granted: 20, used: 0, remaining: 20 },
      error: undefined,
    });
    expect(renderHook(() => useNativeHarnessTrial("org_1")).result.current).toBeNull();

    softQueryMock.mockReturnValue({ data: undefined, error: undefined });
    expect(renderHook(() => useNativeHarnessTrial("org_1")).result.current).toBeNull();

    softQueryMock.mockReturnValue({ data: undefined, error: new Error("boom") });
    expect(renderHook(() => useNativeHarnessTrial("org_1")).result.current).toBeNull();
  });

  it("skips the read without an organization", () => {
    renderHook(() => useNativeHarnessTrial(null));
    expect(softQueryMock).toHaveBeenCalledWith("nativeHarnessTrial:get", "skip");
  });
});

describe("the usage row's numbers", () => {
  it("say how many turns are left of the trial", () => {
    expect(nativeHarnessTurnsLeftText({ remaining: 12, granted: 20 })).toBe(
      "12 / 20 remaining",
    );
    expect(nativeHarnessTurnsLeftPercent({ remaining: 12, granted: 20 })).toBe(60);
    expect(nativeHarnessTurnsLeftPercent({ remaining: 0, granted: 20 })).toBe(0);
    expect(nativeHarnessTurnsLeftPercent({ remaining: 3, granted: 0 })).toBe(0);
  });
});
