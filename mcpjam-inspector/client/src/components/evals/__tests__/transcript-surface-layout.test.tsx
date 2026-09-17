import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EvalTraceSurface } from "../eval-trace-surface";
import { CompareRunChatSurface } from "../compare-run-chat-surface";

vi.mock("../use-eval-trace-blob", () => ({
  useEvalTraceBlob: () => ({ blob: null, loading: false, error: null }),
}));
vi.mock("../trace-viewer", () => ({
  TraceViewer: ({ frame, fillContent }: any) => <div data-testid="viewer"
    data-frame={frame} data-fill={String(fillContent)} />,
}));
const props = {
  iteration: { _id: "iteration", model: "test", createdAt: 1, updatedAt: 2 } as any,
  fallbackTrace: { messages: [{ role: "user", content: "Hello" }] },
  toolsMetadata: {}, toolServerMap: {}, connectedServerIds: [],
};
describe("embedded transcript layout", () => {
  it.each(["eval", "compare"])("gives %s one frame and a direct flex child", (surface) => {
    const { container } = render(surface === "eval"
      ? <EvalTraceSurface {...props} testCase={null} mode="chat" />
      : <CompareRunChatSurface {...props} />);
    const viewer = screen.getByTestId("viewer");
    expect(viewer).toHaveAttribute("data-frame", "none");
    expect(viewer).toHaveAttribute("data-fill", "true");
    expect(viewer.parentElement).toBe(container.firstElementChild);
    expect(viewer.parentElement).toHaveClass("border", "min-h-0", "overflow-hidden");
    expect(viewer.parentElement).not.toHaveClass("p-3");
  });
});
