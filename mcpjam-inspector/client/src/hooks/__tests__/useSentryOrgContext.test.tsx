import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSentryOrgContext } from "../useSentryOrgContext";

const mocks = vi.hoisted(() => ({
  setTag: vi.fn(),
}));

// Mocked at the SDK boundary rather than at `@/lib/sentry-identity`, so these
// assertions exercise the real effect-to-tag path instead of restating it.
vi.mock("@sentry/react", () => ({
  setUser: vi.fn(),
  setTag: mocks.setTag,
}));

describe("useSentryOrgContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tags the org on mount", () => {
    renderHook(() => useSentryOrgContext("org_123"));

    expect(mocks.setTag).toHaveBeenCalledWith("organization_id", "org_123");
  });

  it("replaces the tag when the active org changes", () => {
    const { rerender } = renderHook(
      ({ orgId }: { orgId: string | null }) => useSentryOrgContext(orgId),
      { initialProps: { orgId: "org_123" as string | null } }
    );

    mocks.setTag.mockClear();
    rerender({ orgId: "org_456" });

    expect(mocks.setTag).toHaveBeenLastCalledWith("organization_id", "org_456");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    // An org id is either a real id or absent; "" is neither, and tagging it
    // would produce a searchable-but-empty value that matches nothing.
    ["the empty string", ""],
  ])("clears the tag for %s", (_label, orgId) => {
    renderHook(() => useSentryOrgContext(orgId));

    expect(mocks.setTag).toHaveBeenCalledWith("organization_id", undefined);
  });

  it("clears the tag when the tree unmounts", () => {
    // The scope is global, this hook is not. An error boundary that unmounts
    // App would otherwise leave the org on every event that followed.
    const { unmount } = renderHook(() => useSentryOrgContext("org_123"));

    mocks.setTag.mockClear();
    unmount();

    expect(mocks.setTag).toHaveBeenCalledWith("organization_id", undefined);
  });
});
