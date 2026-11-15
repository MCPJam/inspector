import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import { CandidateRow, maskCandidate } from "../candidate-row";
import { CodeEvaluatorPanel, RUNNER_LIMITS } from "../code-evaluator-panel";

describe("maskCandidate", () => {
  it("keeps short values and truncates long ones after 12 characters", () => {
    expect(maskCandidate("test@ex.com")).toBe("test@ex.com");
    expect(maskCandidate("sk_live_51HxAbCdEfGhQm2a")).toBe("sk_live_51Hx…");
  });
});

describe("CandidateRow", () => {
  it("masks a confirmed secret and shows the model's answer", () => {
    renderWithProviders(
      <CandidateRow
        kind="Stripe secret key"
        value="sk_live_51HxAbCdEfGhQm2a"
        location="get_order result · payment.processor_key"
        verdict="confirmed"
        probability={0.97}
      />,
    );
    expect(screen.getByText("sk_live_51Hx…")).toBeInTheDocument();
    expect(screen.queryByText(/AbCdEf/)).not.toBeInTheDocument();
    expect(screen.getByText("Real")).toBeInTheDocument();
    expect(screen.getByText("Yes · 0.97")).toBeInTheDocument();
    expect(
      screen.getByRole("meter", { name: "Probability this is real" }),
    ).toHaveAttribute("aria-valuenow", "0.97");
  });

  it("shows an allowed value without a model answer", () => {
    renderWithProviders(
      <CandidateRow
        kind="Email address"
        value="jordan@example.com"
        location="get_order result · shipping.email"
        verdict="allowed"
      />,
    );
    expect(screen.getByText("Allowed by case")).toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });
});

describe("CodeEvaluatorPanel", () => {
  const code = [
    "export default defineEvaluator({",
    "  evaluate({ transcript }) {",
    '    return { kind: "scored", score: 1 };',
    "  },",
    "});",
  ].join("\n");

  it("numbers lines, marks the error line and shows the console", () => {
    renderWithProviders(
      <CodeEvaluatorPanel
        fileName="quoted-cart-total.ts"
        code={code}
        errorLine={3}
        consoleOutput="TypeError at line 3"
      />,
    );
    const source = screen.getByRole("region", {
      name: "quoted-cart-total.ts source",
    });
    const marked = source.querySelector("[data-error-line]");
    expect(marked).toHaveTextContent('return { kind: "scored", score: 1 };');
    expect(screen.getByRole("log", { name: "Console" })).toHaveTextContent(
      "TypeError at line 3",
    );
    for (const limit of RUNNER_LIMITS) {
      expect(screen.getByText(limit)).toBeInTheDocument();
    }
  });

  it("runs tests and labels GitHub files as read-only", () => {
    const onRunTests = vi.fn();
    renderWithProviders(
      <CodeEvaluatorPanel
        fileName="quoted-cart-total.ts"
        code={code}
        source="github"
        onRunTests={onRunTests}
      />,
    );
    expect(
      screen.getByText("Synced from GitHub · edits open a pull request"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run tests" }));
    expect(onRunTests).toHaveBeenCalledTimes(1);
  });
});
