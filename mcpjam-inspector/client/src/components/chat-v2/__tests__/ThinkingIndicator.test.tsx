import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { ThinkingIndicator } from "../shared/thinking-indicator";
import type { ModelDefinition } from "@/shared/types";
import { SandboxHostStyleProvider } from "@/contexts/sandbox-host-style-context";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";

const mockUseReducedMotion = vi.hoisted(() => vi.fn(() => false));

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return {
    ...actual,
    useReducedMotion: mockUseReducedMotion,
  };
});

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

  beforeEach(() => {
    mockUseReducedMotion.mockReturnValue(false);
  });

  const renderThinkingIndicator = (ui: ReactElement) =>
    render(
      <PreferencesStoreProvider themeMode="light" themePreset="default">
        {ui}
      </PreferencesStoreProvider>,
    );

  it("renders a leading assistant avatar outside host-style contexts", () => {
    renderThinkingIndicator(<ThinkingIndicator model={defaultModel} />);

    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(screen.getByLabelText("GPT-4 assistant")).toBeInTheDocument();
  });

  it("hides the leading assistant avatar in sandbox host-style contexts", () => {
    renderThinkingIndicator(
      <SandboxHostStyleProvider value="claude">
        <ThinkingIndicator model={defaultModel} />
      </SandboxHostStyleProvider>,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("GPT-4 assistant")).not.toBeInTheDocument();
  });

  it("keeps the default visible thinking label", () => {
    renderThinkingIndicator(<ThinkingIndicator model={defaultModel} />);

    expect(screen.getByText(/Thinking/)).toBeInTheDocument();
    expect(
      screen.queryByTestId("loading-indicator-dot"),
    ).not.toBeInTheDocument();
  });

  it("renders the pulsing dot variant with hidden accessible text", () => {
    renderThinkingIndicator(
      <ThinkingIndicator model={defaultModel} variant="chatgpt-dot" />,
    );

    expect(screen.getByTestId("loading-indicator-dot")).toBeInTheDocument();
    expect(
      screen.getByText("Thinking", { selector: ".sr-only" }),
    ).toBeInTheDocument();
  });

  it("renders the animated Claude mark variant with hidden accessible text", () => {
    renderThinkingIndicator(
      <ThinkingIndicator model={defaultModel} variant="claude-mark" />,
    );

    expect(screen.getByTestId("loading-indicator-claude")).toBeInTheDocument();
    expect(
      screen.getByTestId("loading-indicator-claude-stage"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("loading-indicator-claude-strip-900"),
    ).not.toHaveAttribute("hidden");
    expect(
      screen.getByTestId("loading-indicator-claude-strip-800"),
    ).not.toHaveAttribute("hidden");
    expect(
      screen.getByText("Thinking", { selector: ".sr-only" }),
    ).toBeInTheDocument();
  });
});
