import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { IterationDetails } from "../iteration-details";
import type { EvalIteration } from "../types";

vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
  useQuery: () => undefined,
  // No Convex identity: nothing to wait on, so `useActorCanQuery` lets the
  // suite-config read through exactly as it did before it was gated.
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({ value }: { value: unknown }) => (
    <div data-testid="json-editor">{JSON.stringify(value)}</div>
  ),
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn(),
}));

vi.mock("../trace-viewer", () => ({
  TraceViewer: () => <div data-testid="mock-trace-viewer" />,
}));

const makeIteration = (
  overrides: Partial<EvalIteration> = {},
): EvalIteration => ({
  _id: "iteration-1",
  actualToolCalls: [],
  createdAt: 0,
  createdBy: "user-1",
  iterationNumber: 1,
  result: "failed",
  startedAt: 0,
  status: "failed",
  tokensUsed: 0,
  updatedAt: 0,
  ...overrides,
});

afterEach(() => {
  cleanup();
});

const execution = {
  requested: {
    modelId: "openai/gpt-5",
    source: "hosted",
    fallback: { provider: "openrouter", model: "none" },
  },
  resolved: {
    rail: "gateway",
    wireModelId: "openai/gpt-5",
    offering: { rail: "gateway", providerKey: "gateway" },
  },
  effectiveSettings: { temperature: 0.2, maxOutputTokens: 2048 },
  attempts: [],
  deviation: {
    kind: "provider_fallback",
    reason: "The openrouter fallback served the request.",
  },
};

// The record stays on the iteration, but the details view no longer shows it.
describe("IterationDetails execution provenance", () => {
  it("does not show what the iteration ran on, even with a record", () => {
    render(
      <IterationDetails
        iteration={makeIteration({ execution })}
        testCase={null}
      />,
    );

    expect(screen.queryByText(/Ran on/)).toBeNull();
    expect(screen.queryByText(/Deviation:/)).toBeNull();
    expect(screen.queryByTestId("iteration-execution-provenance")).toBeNull();
  });
});
