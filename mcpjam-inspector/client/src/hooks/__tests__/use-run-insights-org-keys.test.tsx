import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useRunInsights } from "@/hooks/use-run-insights";

const { state } = vi.hoisted(() => ({
  state: { dto: null as unknown },
}));

vi.mock("convex/react", () => ({
  useQuery: () => state.dto,
  useMutation: () => vi.fn(),
}));

function render() {
  return renderHook(() =>
    useRunInsights(
      { kind: "scenario", scenarioId: "cb-1", groupId: "g-1" },
      { terminal: true },
    ),
  ).result.current;
}

describe("useRunInsights — organization AI-key refusals", () => {
  it("names a configuration refusal as Not analyzed", () => {
    state.dto = {
      status: "failed",
      errorCode: "org_model_unconfigured",
      errorMessage: "Run insights is unavailable: …",
    };
    expect(render().error).toBe(
      "Not analyzed: this organization requires its own provider keys and has no model configured for analysis.",
    );
  });

  it("names a provider credential refusal without a generic failure", () => {
    state.dto = { status: "failed", errorCode: "provider_auth_failed" };
    expect(render().error).toBe(
      "Not analyzed: the organization's provider rejected its API key.",
    );
  });

  it("keeps the backend's message for other failures", () => {
    state.dto = {
      status: "failed",
      errorCode: "model_error",
      errorMessage: "The model failed.",
    };
    expect(render().error).toBe("The model failed.");
  });
});
