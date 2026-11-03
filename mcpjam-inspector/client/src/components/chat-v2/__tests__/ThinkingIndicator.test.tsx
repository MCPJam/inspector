import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { ThinkingIndicator } from "../shared/thinking-indicator";
import type { ModelDefinition } from "@/shared/types";
import { ScenarioHostStyleProvider } from "@/contexts/scenario-client-style-context";
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
  const openaiModel: ModelDefinition = {
    id: "gpt-4",
    name: "GPT-4",
    provider: "openai",
    contextWindow: 8192,
    maxOutputTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
  };

  // Provider that doesn't map to any registered host — exercises the
  // generic "Thinking…" fallback path.
  const unmappedProviderModel: ModelDefinition = {
    ...openaiModel,
    id: "mistral-7b",
    name: "Mistral 7B",
    provider: "mistral",
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

  it("delays startup phases and clears them when startup ends", () => {
    vi.useFakeTimers();
    try {
      const view = renderThinkingIndicator(
        <ThinkingIndicator model={openaiModel} startupPhase="computer" />,
      );
      expect(screen.queryByText("Starting your computer…")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(499));
      expect(screen.queryByText("Starting your computer…")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByText("Starting your computer…")).toBeInTheDocument();
      view.rerender(
        <PreferencesStoreProvider themeMode="light" themePreset="default">
          <ThinkingIndicator model={openaiModel} startupPhase={null} />
        </PreferencesStoreProvider>,
      );
      expect(screen.queryByText("Starting your computer…")).not.toBeInTheDocument();
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a leading assistant avatar outside host-style contexts", () => {
    renderThinkingIndicator(<ThinkingIndicator model={openaiModel} />);

    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(screen.getByLabelText("GPT-4 assistant")).toBeInTheDocument();
  });

  it("hides the leading assistant avatar in scenario host-style contexts", () => {
    renderThinkingIndicator(
      <ScenarioHostStyleProvider value="claude">
        <ThinkingIndicator model={openaiModel} />
      </ScenarioHostStyleProvider>,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("GPT-4 assistant")).not.toBeInTheDocument();
  });

  it("renders the generic 'Thinking…' label when neither host nor provider resolves", () => {
    renderThinkingIndicator(
      <ThinkingIndicator model={unmappedProviderModel} />,
    );

    expect(screen.getByText(/Thinking/)).toBeInTheDocument();
    expect(
      screen.queryByTestId("loading-indicator-dot"),
    ).not.toBeInTheDocument();
  });

  it("renders the pulsing dot for OpenAI models when no host context is set", () => {
    renderThinkingIndicator(<ThinkingIndicator model={openaiModel} />);

    expect(screen.getByTestId("loading-indicator-dot")).toBeInTheDocument();
    expect(
      screen.getByText("Thinking", { selector: ".sr-only" }),
    ).toBeInTheDocument();
  });

  it("renders the animated Claude mark inside a Claude scenario host context", () => {
    renderThinkingIndicator(
      <ScenarioHostStyleProvider value="claude">
        <ThinkingIndicator model={openaiModel} />
      </ScenarioHostStyleProvider>,
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
