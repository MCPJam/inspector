import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePostHogOrgContext } from "../usePostHogOrgContext";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    register: mocks.register,
    unregister: mocks.unregister,
  }),
}));

describe("usePostHogOrgContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the org id and name", () => {
    renderHook(() => usePostHogOrgContext("org_123", "Acme"));

    expect(mocks.register).toHaveBeenCalledWith({ organization_id: "org_123" });
    expect(mocks.register).toHaveBeenCalledWith({ organization_name: "Acme" });
  });

  it("registers the id alone and clears the name when no name is passed", () => {
    renderHook(() => usePostHogOrgContext("org_123", undefined));

    expect(mocks.register).toHaveBeenCalledWith({ organization_id: "org_123" });
    expect(mocks.register).not.toHaveBeenCalledWith(
      expect.objectContaining({ organization_name: expect.anything() }),
    );
    expect(mocks.unregister).toHaveBeenCalledWith("organization_name");
  });

  it("clears the name when the person joins an enterprise-privacy org", () => {
    const { rerender } = renderHook(
      ({ name }: { name: string | undefined }) =>
        usePostHogOrgContext("org_123", name),
      { initialProps: { name: "Acme" as string | undefined } },
    );

    mocks.unregister.mockClear();
    rerender({ name: undefined });

    expect(mocks.unregister).toHaveBeenCalledWith("organization_name");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("clears both properties when the org id is %s", (_label, orgId) => {
    renderHook(() => usePostHogOrgContext(orgId, "Acme"));

    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.unregister).toHaveBeenCalledWith("organization_id");
    expect(mocks.unregister).toHaveBeenCalledWith("organization_name");
  });
});
