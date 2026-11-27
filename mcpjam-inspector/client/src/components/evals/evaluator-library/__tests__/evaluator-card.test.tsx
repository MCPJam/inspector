import { describe, expect, it, vi } from "vitest";
import { Wrench } from "lucide-react";
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
  onOpen: () => {},
  onAdd: () => {},
};

describe("EvaluatorCard", () => {
  it("shows the name, question and parts", () => {
    renderWithProviders(<EvaluatorCard {...base} />);
    expect(
      screen.getByRole("heading", { name: "Expected Tool Calls" }),
    ).toBeInTheDocument();
    expect(screen.getByText(base.question)).toBeInTheDocument();
    expect(screen.getByText("3 assertions")).toBeInTheDocument();
    expect(screen.getByText("1 choice question")).toBeInTheDocument();
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

  it("explains a disabled Add", () => {
    renderWithProviders(
      <EvaluatorCard
        {...base}
        onAdd={() => {}}
        addDisabledReason="Remove a question first."
      />,
    );
    expect(
      screen.getByRole("button", { name: "Add Expected Tool Calls to suite" }),
    ).toBeDisabled();
    expect(screen.getByText("Remove a question first.")).toBeInTheDocument();
  });
});
