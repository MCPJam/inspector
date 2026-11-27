import { describe, expect, it, vi } from "vitest";
import { Syringe, Wrench } from "lucide-react";
import { fireEvent, renderWithProviders, screen } from "@/test";
import { EvaluatorCard, type EvaluatorCardProps } from "../evaluator-card";

const base: EvaluatorCardProps = {
  name: "Expected Tool Calls",
  question:
    "Did the agent call the tools this case expects, with matching arguments?",
  icon: Wrench,
  tone: "tools",
  builtFrom: [
    { kind: "assertions", label: "3 assertions" },
    { kind: "question", label: "1 choice question" },
  ],
  dependency: "expectedToolCalls",
  onOpen: () => {},
};

describe("EvaluatorCard", () => {
  it("shows the name, question, parts and case dependency", () => {
    renderWithProviders(<EvaluatorCard {...base} />);
    expect(
      screen.getByRole("heading", { name: "Expected Tool Calls" }),
    ).toBeInTheDocument();
    expect(screen.getByText(base.question)).toBeInTheDocument();
    expect(screen.getByText("3 assertions")).toBeInTheDocument();
    expect(screen.getByText("1 choice question")).toBeInTheDocument();
    expect(screen.getByText("Uses expected tool calls")).toBeInTheDocument();
  });

  it("shows Ready when the evaluator reads no case field", () => {
    renderWithProviders(<EvaluatorCard {...base} dependency={undefined} />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("opens from the name and adds from a separate button", () => {
    const onOpen = vi.fn();
    const onAdd = vi.fn();
    renderWithProviders(
      <EvaluatorCard {...base} onOpen={onOpen} onAdd={onAdd} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Expected Tool Calls" }),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Add Expected Tool Calls to suite" }),
    );
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("replaces Add with an In suite marker once added", () => {
    renderWithProviders(<EvaluatorCard {...base} inSuite onAdd={() => {}} />);
    expect(screen.getByText("In suite")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /add expected tool calls/i }),
    ).not.toBeInTheDocument();
  });

  it("marks the open evaluator and tags security evaluators", () => {
    renderWithProviders(
      <EvaluatorCard
        {...base}
        name="Ignores Injected Instructions"
        icon={Syringe}
        tone="security"
        owasp={["MCP06"]}
        dependency="attackFixture"
        selected
      />,
    );
    expect(screen.getByRole("article")).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("article")).toHaveTextContent(
      "OWASP MCP Top 10: MCP06",
    );
    expect(screen.getByText("Uses attack fixture")).toBeInTheDocument();
  });
});
