import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ModelDefinition } from "@/shared/types";
import { SystemPromptSelector } from "../system-prompt-selector";

const model = (id: string): ModelDefinition => ({
  id,
  name: id,
  provider: "anthropic",
});

/** Rejects `temperature` outright (Anthropic 400s on it). */
const REJECTING = model("claude-opus-4-8");
/** Accepts `temperature` on the wire but ignores anything but the default. */
const IGNORING = model("gpt-5");
const ACCEPTING = model("anthropic/claude-sonnet-4.6");

function renderSelector(
  props: Partial<React.ComponentProps<typeof SystemPromptSelector>> = {},
) {
  return render(
    <SystemPromptSelector
      systemPrompt="You are helpful."
      onSystemPromptChange={vi.fn()}
      temperature={0.7}
      onTemperatureChange={vi.fn()}
      onResetChat={vi.fn()}
      currentModel={ACCEPTING}
      open
      onOpenChange={vi.fn()}
      {...props}
    />,
  );
}

/**
 * Radix renders the slider thumb as a `<span>` and marks the disabled state with
 * `data-disabled`, not the `disabled` attribute — jest-dom's `toBeDisabled` only
 * understands form controls, so it would pass either way here.
 */
const sliderIsDisabled = () =>
  screen.getByRole("slider").hasAttribute("data-disabled");

describe("SystemPromptSelector temperature control", () => {
  it("disables the slider when every selected model ignores temperature", () => {
    renderSelector({
      multiModelEnabled: true,
      selectedModels: [REJECTING, IGNORING],
    });

    expect(sliderIsDisabled()).toBe(true);
    expect(
      screen.getByText(/Temperature is not supported for the selected models/),
    ).toBeInTheDocument();
  });

  it("disables the slider for a single model that rejects temperature", () => {
    renderSelector({ currentModel: REJECTING });

    expect(sliderIsDisabled()).toBe(true);
    expect(
      screen.getByText(/Temperature is not supported for the selected models/),
    ).toBeInTheDocument();
  });

  it("keeps the slider usable but warns on a mixed selection", () => {
    renderSelector({
      multiModelEnabled: true,
      selectedModels: [REJECTING, ACCEPTING],
    });

    expect(sliderIsDisabled()).toBe(false);
    expect(
      screen.getByText(/Some selected models do not support temperature/),
    ).toBeInTheDocument();
  });

  it("shows the default guidance when no selected model ignores temperature", () => {
    renderSelector({
      multiModelEnabled: true,
      selectedModels: [ACCEPTING],
    });

    expect(sliderIsDisabled()).toBe(false);
    expect(screen.getByText(/Lower values \(0-0\.3\)/)).toBeInTheDocument();
  });

  it.each([
    ["omitted", undefined],
    ["empty", [] as ModelDefinition[]],
  ])(
    "falls back to currentModel when selectedModels is %s",
    (_label, selectedModels) => {
      renderSelector({
        multiModelEnabled: true,
        selectedModels,
        currentModel: REJECTING,
      });

      expect(sliderIsDisabled()).toBe(true);
      expect(
        screen.getByText(/Temperature is not supported for the selected models/),
      ).toBeInTheDocument();
    },
  );

  it("ignores selectedModels while multi-model is off", () => {
    renderSelector({
      multiModelEnabled: false,
      selectedModels: [REJECTING],
      currentModel: ACCEPTING,
    });

    expect(sliderIsDisabled()).toBe(false);
    expect(screen.getByText(/Lower values \(0-0\.3\)/)).toBeInTheDocument();
  });
});
