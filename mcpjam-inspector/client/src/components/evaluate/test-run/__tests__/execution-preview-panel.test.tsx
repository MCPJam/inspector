import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Predicate } from "@/shared/eval-matching";
import { buildExecutionPreview } from "../../case-steps/case-steps-model";
import { ExecutionPreviewPanel } from "../execution-preview-panel";

const caseCheck: Predicate = { type: "responseContains", text: "done" };

describe("ExecutionPreviewPanel", () => {
  it("numbers the expected outcome after the steps, then the after-run assertions", () => {
    const preview = buildExecutionPreview({
      steps: [
        { id: "p1", kind: "prompt", prompt: "Draw two nodes" },
        { id: "p2", kind: "prompt", prompt: "Connect them" },
      ],
      predicates: { mode: "extend", list: [caseCheck] },
      expectedOutput: "Two connected nodes",
    });
    render(
      <ExecutionPreviewPanel
        preview={preview}
        onOpenStep={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const order = [
      "Step 1 · ",
      "Step 2 · ",
      "Step 3 · Expected outcome",
      "Step 4 · After-run assertions",
      "Suite default evaluators",
    ].map((text) =>
      screen.getByText((_, node) =>
        Boolean(
          node?.textContent?.startsWith(text) &&
          [...(node.children ?? [])].every(
            (child) => !child.textContent?.startsWith(text),
          ),
        ),
      ),
    );
    for (let i = 1; i < order.length; i += 1) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });
});
