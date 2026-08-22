import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({
    availableModels: [
      { id: "gpt-4", name: "GPT-4", provider: "openai" },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
    ],
  }),
}));

import { ModelsPill } from "../models-pill";

describe("ModelsPill", () => {
  it("shows the empty prompt until a model is picked", () => {
    const onChange = vi.fn();
    render(
      <ModelsPill projectId="proj-1" value={null} onChange={onChange} />,
    );

    const trigger = screen.getByRole("button", { name: "Model" });
    expect(trigger).toHaveTextContent(/choose a model/i);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "GPT-4" }));
    expect(onChange).toHaveBeenCalledWith("gpt-4");
  });

  it("labels the trigger with the selected model", () => {
    render(
      <ModelsPill
        projectId="proj-1"
        value="claude-sonnet-4-5"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "Claude Sonnet 4.5",
    );
  });
});
