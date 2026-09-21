import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const capability = vi.hoisted(() => ({
  value: undefined as boolean | undefined,
}));

vi.mock("@/hooks/use-model-matrix-capability", () => ({
  useModelMatrixCapability: (projectId: string | null) =>
    projectId ? capability.value : undefined,
}));

import { useEvalComposeCapable } from "../use-eval-compose-capable";

describe("useEvalComposeCapable", () => {
  it("is neither capable nor pending without a project", () => {
    capability.value = true;
    const { result } = renderHook(() => useEvalComposeCapable(null));
    expect(result.current).toEqual({ capable: false, pending: false });
  });

  it("reports pending while the probe is in flight", () => {
    // Distinct from "not capable": callers disable the compose strip rather
    // than rendering the legacy one and swapping it a frame later.
    capability.value = undefined;
    const { result } = renderHook(() => useEvalComposeCapable("proj-1"));
    expect(result.current).toEqual({ capable: false, pending: true });
  });

  it("is capable when the deployment advertises the matrix", () => {
    capability.value = true;
    const { result } = renderHook(() => useEvalComposeCapable("proj-1"));
    expect(result.current).toEqual({ capable: true, pending: false });
  });

  it("is not capable on a skewed backend", () => {
    capability.value = false;
    const { result } = renderHook(() => useEvalComposeCapable("proj-1"));
    expect(result.current).toEqual({ capable: false, pending: false });
  });
});
