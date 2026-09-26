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

describe("IterationDetails execution provenance", () => {
  it("shows what the iteration ran on and a visible deviation banner", () => {
    render(
      <IterationDetails
        iteration={makeIteration({ execution })}
        testCase={null}
      />,
    );

    expect(
      screen.getByTestId("iteration-execution-provenance-line").textContent,
    ).toBe(
      "Ran on openai/gpt-5 via Vercel AI Gateway (MCPJam key), temperature 0.2, max output 2,048 tokens",
    );
    expect(
      screen.getByTestId("iteration-execution-deviation-banner").textContent,
    ).toContain("Deviation: Provider fallback");
  });

  it("shows no provenance for an iteration recorded before records existed", () => {
    render(<IterationDetails iteration={makeIteration()} testCase={null} />);

    expect(screen.queryByTestId("iteration-execution-provenance")).toBeNull();
    expect(
      screen.queryByTestId("iteration-execution-deviation-banner"),
    ).toBeNull();
  });
});
