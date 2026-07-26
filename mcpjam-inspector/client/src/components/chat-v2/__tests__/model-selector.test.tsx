import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelSelector } from "../chat-input/model-selector";
import type { ModelDefinition } from "@/shared/types";
import { useModelPickerIntentStore } from "@/stores/model-picker-intent-store";

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));

vi.mock("@/lib/analytics", () => ({
  track: vi.fn(),
}));

vi.mock("../chat-input/model/provider-logo", () => ({
  ProviderLogo: ({ provider }: { provider: string }) => (
    <span aria-hidden="true">{provider}</span>
  ),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (
    selector: (state: { themeMode: "light" | "dark" }) => unknown
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

const outOfCreditsModels: ModelDefinition[] = [
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5 (Free)",
    provider: "anthropic",
    disabled: true,
    disabledReason: "You're out of credits. Top up or use your own key.",
  },
  {
    id: "gpt-5-mini",
    name: "GPT-5 Mini",
    provider: "openai",
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

// Mirrors the shape the reporter hit: the free tier is out of credits and the
// user's Anthropic key exposes the whole BYOK list in SUPPORTED_MODELS order —
// Claude Fable 5 first, and (like every own-provider row) not marked disabled
// even when the key has no access to it.
const byokIntentModels: ModelDefinition[] = [
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5 (Free)",
    provider: "anthropic",
    hosted: true,
    disabled: true,
    disabledReason: "You're out of credits. Top up or use your own key.",
  },
  { id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" },
];

function ProviderIntentControlledModelSelector({
  availableModels = outOfCreditsModels,
}: {
  availableModels?: ModelDefinition[];
} = {}) {
  const [currentModel, setCurrentModel] = useState<ModelDefinition>(
    availableModels[0]!
  );

  return (
    <ModelSelector
      currentModel={currentModel}
      availableModels={availableModels}
      onModelChange={setCurrentModel}
      respondToProviderTabIntent
    />
  );
}

describe("ModelSelector", () => {
  beforeEach(() => {
    useModelPickerIntentStore.setState({ openProvidersTabNonce: 0 });
    localStorage.clear();
  });

  it("keeps the popover open when multiple models are enabled", async () => {
    const user = userEvent.setup();

    render(<ControlledModelSelector />);

    await user.click(screen.getByRole("button", { name: /gpt-4\.1/i }));
    expect(screen.getByPlaceholderText("Search models")).toBeInTheDocument();

    await user.click(
      screen.getByRole("switch", { name: "Use multiple models" })
    );

    expect(screen.getByPlaceholderText("Search models")).toBeInTheDocument();
    expect(screen.getByText("Multiple models")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Use multiple models" })
    ).toHaveAttribute("aria-checked", "true");
  });

  it("does not show the removed multi-model helper tooltip", async () => {
    const user = userEvent.setup();

    render(<ControlledModelSelector />);

    await user.click(screen.getByRole("button", { name: /gpt-4\.1/i }));
    await user.hover(screen.getByText("Multiple models"));

    expect(
      screen.queryByText(
        /Compare up to 3 models in one composer\. The first in your selection runs first\./i
      )
    ).not.toBeInTheDocument();
  });

  it("does not re-emit open state when only the callback prop changes", async () => {
    const user = userEvent.setup();
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();

    const { rerender } = render(
      <OpenChangeProbe onOpenChange={firstCallback} />
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
      />
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
      />
    );

    expect(screen.getByPlaceholderText("Search models")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Use multiple models" })
    ).toHaveAttribute("aria-checked", "true");
    const trigger = screen.getByTestId("model-selector-trigger");
    expect(trigger).toHaveTextContent("GPT-4.1");
    expect(trigger).toHaveTextContent("Claude 3.7 Sonnet");
    expect(trigger).not.toHaveTextContent("+1");
    expect(screen.getAllByText("Claude 3.7 Sonnet").length).toBeGreaterThan(0);
  });

  it("selects an enabled provider model when the BYOK intent opens providers", async () => {
    render(<ProviderIntentControlledModelSelector />);

    act(() => {
      useModelPickerIntentStore.getState().requestOpenProvidersTab();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /gpt-5 mini/i })).toBeVisible();
    });

    expect(screen.getByPlaceholderText("Search models")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
  });

  // BACK2-628: the hand-off used to take the first row of the "Your providers"
  // list, which is Claude Fable 5 — a model the reporter's Anthropic key had
  // no access to, so their first tool call failed every chat.
  it("does not fall to the first own-provider row on the BYOK intent", async () => {
    render(
      <ProviderIntentControlledModelSelector
        availableModels={byokIntentModels}
      />
    );

    act(() => {
      useModelPickerIntentStore.getState().requestOpenProvidersTab();
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("model-selector-trigger")
      ).toHaveTextContent("Haiku 4.5");
    });
    expect(screen.getByTestId("model-selector-trigger")).not.toHaveTextContent(
      "Fable"
    );
  });

  it("restores the last own-provider model on the BYOK intent", async () => {
    localStorage.setItem("mcp-inspector-last-own-provider-model", "gpt-5-mini");

    render(
      <ProviderIntentControlledModelSelector
        availableModels={byokIntentModels}
      />
    );

    act(() => {
      useModelPickerIntentStore.getState().requestOpenProvidersTab();
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("model-selector-trigger")
      ).toHaveTextContent("GPT-5 Mini");
    });
  });

  it("leaves an own-provider selection alone when the BYOK intent fires", async () => {
    const onModelChange = vi.fn();

    render(
      <ModelSelector
        // Already on their own key — the reporter's state after manually
        // picking Haiku. Re-selecting here is what made the choice look
        // like it never stuck.
        currentModel={byokIntentModels[2]!}
        availableModels={byokIntentModels}
        onModelChange={onModelChange}
        respondToProviderTabIntent
      />
    );

    act(() => {
      useModelPickerIntentStore.getState().requestOpenProvidersTab();
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search models")).toBeInTheDocument();
    });
    expect(onModelChange).not.toHaveBeenCalled();
  });
});
