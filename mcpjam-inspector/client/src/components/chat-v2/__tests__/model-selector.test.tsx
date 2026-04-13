import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelSelector } from "../chat-input/model-selector";
import type { ModelDefinition } from "@/shared/types";

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));

vi.mock("../chat-input/model/provider-logo", () => ({
  ProviderLogo: ({ provider }: { provider: string }) => (
    <span aria-hidden="true">{provider}</span>
  ),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (
    selector: (state: { themeMode: "light" | "dark" }) => unknown,
  ) => selector({ themeMode: "light" }),
}));

const models: ModelDefinition[] = [
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
  },
  {
    id: "claude-3-7-sonnet",
    name: "Claude 3.7 Sonnet",
    provider: "anthropic",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
  },
];

function ControlledModelSelector() {
  const [currentModel, setCurrentModel] = useState(models[0]);
  const [selectedModels, setSelectedModels] = useState<ModelDefinition[]>([
    models[0],
  ]);
  const [multiModelEnabled, setMultiModelEnabled] = useState(false);

  return (
    <ModelSelector
      currentModel={currentModel}
      availableModels={models}
      onModelChange={(model) => {
        setCurrentModel(model);
        setSelectedModels([model]);
        setMultiModelEnabled(false);
      }}
      enableMultiModel={true}
      multiModelEnabled={multiModelEnabled}
      selectedModels={selectedModels}
      onSelectedModelsChange={(nextModels) => {
        setSelectedModels(nextModels);
        if (nextModels[0]) {
          setCurrentModel(nextModels[0]);
        }
      }}
      onMultiModelEnabledChange={setMultiModelEnabled}
    />
  );
}

function OpenChangeProbe({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ModelSelector
      currentModel={models[0]}
      availableModels={models}
      onModelChange={() => {}}
      onOpenChange={onOpenChange}
      enableMultiModel={true}
      multiModelEnabled={false}
      selectedModels={[models[0]]}
      onSelectedModelsChange={() => {}}
      onMultiModelEnabledChange={() => {}}
    />
  );
}

describe("ModelSelector", () => {
  it("keeps the popover open when multiple models are enabled", async () => {
    const user = userEvent.setup();

    render(<ControlledModelSelector />);

    await user.click(screen.getByRole("button", { name: /gpt-4\.1/i }));
    expect(screen.getByPlaceholderText("Search models")).toBeInTheDocument();

    await user.click(
      screen.getByRole("switch", { name: "Use multiple models" }),
    );

    expect(screen.getByPlaceholderText("Search models")).toBeInTheDocument();
    expect(screen.getByText("Multiple models")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Use multiple models" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("does not show the removed multi-model helper tooltip", async () => {
    const user = userEvent.setup();

    render(<ControlledModelSelector />);

    await user.click(screen.getByRole("button", { name: /gpt-4\.1/i }));
    await user.hover(screen.getByText("Multiple models"));

    expect(
      screen.queryByText(
        /Compare up to 3 models in one composer\. The first in your selection runs first\./i,
      ),
    ).not.toBeInTheDocument();
  });

  it("does not re-emit open state when only the callback prop changes", async () => {
    const user = userEvent.setup();
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();

    const { rerender } = render(
      <OpenChangeProbe onOpenChange={firstCallback} />,
    );

    await user.click(screen.getByRole("button", { name: /gpt-4\.1/i }));

    expect(firstCallback).toHaveBeenCalledWith(true);
    firstCallback.mockClear();

    rerender(<OpenChangeProbe onOpenChange={secondCallback} />);

    expect(secondCallback).not.toHaveBeenCalledWith(true);
  });

  it("stays open when parent props switch into multi-model mode", async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();
    const onSelectedModelsChange = vi.fn();
    const onMultiModelEnabledChange = vi.fn();

    const { rerender } = render(
      <ModelSelector
        currentModel={models[0]}
        availableModels={models}
        onModelChange={onModelChange}
        enableMultiModel={true}
        multiModelEnabled={false}
        selectedModels={[models[0]]}
        onSelectedModelsChange={onSelectedModelsChange}
        onMultiModelEnabledChange={onMultiModelEnabledChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /gpt-4\.1/i }));
    expect(screen.getByPlaceholderText("Search models")).toBeInTheDocument();

    rerender(
      <ModelSelector
        currentModel={models[0]}
        availableModels={models}
        onModelChange={onModelChange}
        enableMultiModel={true}
        multiModelEnabled={true}
        selectedModels={[models[0], models[1]]}
        onSelectedModelsChange={onSelectedModelsChange}
        onMultiModelEnabledChange={onMultiModelEnabledChange}
      />,
    );

    expect(screen.getByPlaceholderText("Search models")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Use multiple models" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByText("Claude 3.7 Sonnet").length).toBeGreaterThan(0);
  });
});
