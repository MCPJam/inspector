import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MultiModelStarterPromptsBlock } from "../multi-model-starters-empty";
import { STARTER_PROMPTS } from "../shared/chat-helpers";

// Starter prompts must be answerable from the model's own tool list alone —
// the playground chat has no meta-tools (server inventory, activity logs), so
// prompts that ask for those always dead-end. See the copy review that
// replaced "List my connected MCP servers…" / "Summarize the most recent
// activity…" with introspection-friendly phrasing.
describe("STARTER_PROMPTS", () => {
  it("only contains prompts answerable from the model's visible tool list", () => {
    expect(STARTER_PROMPTS).toEqual([
      { label: "What can this server do?", text: "What can this server do?" },
      { label: "What tools can I use?", text: "What tools can I use?" },
      {
        label: "Give me example prompts to try",
        text: "Give me example prompts to try",
      },
    ]);
  });
});

describe("MultiModelStarterPromptsBlock", () => {
  it("renders a chip per starter prompt and sends the prompt text on click", () => {
    const onStarterPrompt = vi.fn();
    render(<MultiModelStarterPromptsBlock onStarterPrompt={onStarterPrompt} />);

    expect(
      screen.getByText("Try one of these to get started"),
    ).toBeInTheDocument();

    for (const prompt of STARTER_PROMPTS) {
      fireEvent.click(screen.getByRole("button", { name: prompt.label }));
      expect(onStarterPrompt).toHaveBeenLastCalledWith(prompt.text);
    }
    expect(onStarterPrompt).toHaveBeenCalledTimes(STARTER_PROMPTS.length);
  });
});
