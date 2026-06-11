import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { IterationDetails } from "../iteration-details";
import type { EvalIteration } from "../types";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
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

beforeEach(() => {
  useMCPJamLimitDialogStore.setState({
    authStatus: "loading",
    hasPendingLimit: false,
    isOpen: false,
    intent: null,
    organizationId: null,
    pendingInput: null,
  });
});

describe("IterationDetails guest daily-limit handling", () => {
  it("does not open the mcpjam-limit dialog when rendering historical error details", () => {
    render(
      <IterationDetails
        iteration={makeIteration({
          error: "Backend stream error: 429",
          errorDetails: JSON.stringify({
            code: "mcpjam_rate_limit",
            error: "Daily usage limit reached.",
          }),
        })}
        testCase={null}
      />,
    );

    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });
});
