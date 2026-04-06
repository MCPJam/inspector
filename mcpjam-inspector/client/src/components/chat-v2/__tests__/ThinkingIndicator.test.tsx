import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThinkingIndicator } from "../shared/thinking-indicator";
import type { ModelDefinition } from "@/shared/types";

describe("ThinkingIndicator", () => {
  const defaultModel: ModelDefinition = {
    id: "gpt-4",
    name: "GPT-4",
    provider: "openai",
    contextWindow: 8192,
    maxOutputTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
  };

  it("does not render a leading assistant avatar", () => {
    render(<ThinkingIndicator model={defaultModel} />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("GPT-4 response")).not.toBeInTheDocument();
  });

  it("keeps the default visible thinking label", () => {
    render(<ThinkingIndicator model={defaultModel} />);

    expect(screen.getByText(/Thinking/)).toBeInTheDocument();
    expect(
      screen.queryByTestId("loading-indicator-dot"),
    ).not.toBeInTheDocument();
  });

  it("renders the pulsing dot variant with hidden accessible text", () => {
    render(<ThinkingIndicator model={defaultModel} variant="chatgpt-dot" />);

    expect(screen.getByTestId("loading-indicator-dot")).toBeInTheDocument();
    expect(
      screen.getByText("Thinking", { selector: ".sr-only" }),
    ).toBeInTheDocument();
  });

  it("renders the Claude mark variant with hidden accessible text", () => {
    render(<ThinkingIndicator model={defaultModel} variant="claude-mark" />);

    expect(screen.getByTestId("loading-indicator-claude")).toBeInTheDocument();
    expect(
      screen.getByText("Thinking", { selector: ".sr-only" }),
    ).toBeInTheDocument();
  });
});
