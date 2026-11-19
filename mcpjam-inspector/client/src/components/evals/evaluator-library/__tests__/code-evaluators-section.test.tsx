import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { codeEvaluatorTrialRows } from "@/components/evaluate/case-scorecard/code-evaluator-trial-rows";
import { CodeEvaluatorsSection } from "../code-evaluators-section";
import { codeEvaluatorProblem } from "../code-evaluators-model";

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (name: string) => name === "evaluator-library",
}));

const capabilities = {
  codeEvaluators: { maxEvaluators: 5, maxSourceChars: 20000 },
} as unknown as SuiteCapabilities;

describe("CodeEvaluatorsSection", () => {
  it("renders nothing where the backend cannot store code evaluators", () => {
    const { container } = renderWithProviders(
      <CodeEvaluatorsSection value={[]} onChange={() => {}} capabilities={{} as SuiteCapabilities} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("starts from a starter as an editable copy and saves it", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <CodeEvaluatorsSection value={[]} onChange={onChange} capabilities={capabilities} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start from: No empty tool results" }));
    fireEvent.click(screen.getByRole("button", { name: "Save code" }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "no-empty-tool-results",
        label: "No empty tool results",
        role: "required",
        basedOn: { id: "no-empty-tool-results", version: 1 },
      }),
    ]);
  });

  it("refuses to save without a name", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <CodeEvaluatorsSection value={[]} onChange={onChange} capabilities={capabilities} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Write code" }));
    fireEvent.click(screen.getByRole("button", { name: "Save code" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give the evaluator a name.");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("code evaluator model", () => {
  const base = { id: "a", label: "A", source: "export function evaluate() {}", role: "advisory" as const };
  it("mirrors the backend's checks", () => {
    expect(codeEvaluatorProblem(base, [])).toBeUndefined();
    expect(codeEvaluatorProblem({ ...base, id: "Bad Id" }, [])).toContain("lowercase");
    expect(codeEvaluatorProblem(base, [base])).toContain("Another code evaluator");
    expect(codeEvaluatorProblem({ ...base, source: "export const x = 1;" }, [])).toContain("evaluate");
  });
});

describe("code evaluator scorecard rows", () => {
  it("shows a pass, a fail with logs, and an error as its own state", () => {
    const rows = codeEvaluatorTrialRows({
      metadata: {
        codeEvaluatorResults: [
          { id: "a", label: "A", role: "required", status: "scored", pass: true, reason: "ok" },
          { id: "b", label: "B", role: "advisory", status: "scored", pass: false, reason: "no 42", logs: "saw 41" },
          { id: "c", label: "C", role: "required", status: "error", reason: "Stopped after 10 seconds." },
        ],
      },
    } as never);
    expect(rows.map((r) => [r.key, r.role, r.result.state])).toEqual([
      ["code:a", "required", "passed"],
      ["code:b", "advisory", "failed"],
      ["code:c", "required", "error"],
    ]);
    expect("reason" in rows[1].result && rows[1].result.reason).toContain("Logs: saw 41");
  });
});
