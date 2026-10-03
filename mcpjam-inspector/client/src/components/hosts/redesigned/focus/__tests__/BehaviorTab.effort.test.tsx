import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import type { ModelDefinition } from "@/shared/types";
import { BehaviorTab } from "../BehaviorTab";

const GPT5: ModelDefinition = {
  id: "openai/gpt-5",
  name: "GPT-5",
  provider: "openai",
  hosted: true,
  supportedReasoningEfforts: ["low", "medium", "high"],
} as ModelDefinition;
const GPT4O: ModelDefinition = {
  id: "openai/gpt-4o",
  name: "GPT-4o",
  provider: "openai",
  hosted: true,
} as ModelDefinition;
const HAIKU: ModelDefinition = {
  id: "anthropic/claude-haiku-4.5",
  name: "Claude Haiku 4.5",
  provider: "anthropic",
  hosted: true,
  supportedReasoningEfforts: ["low", "high"],
} as ModelDefinition;

const models = vi.hoisted(() => ({ supported: true }));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({
    availableModels: [GPT5, GPT4O, HAIKU],
    modelSelectionsSupported: models.supported,
  }),
}));
vi.mock("@/hooks/useHarnessCapabilities", () => ({
  useHarnessCapabilities: () => ({ capabilities: undefined, loading: false }),
}));
vi.mock("@/components/chat-v2/chat-input/model-selector", () => ({
  ModelSelector: ({
    onModelChange,
    availableModels,
  }: {
    onModelChange: (model: ModelDefinition) => void;
    availableModels: ModelDefinition[];
  }) => (
    <div>
      {availableModels.map((model) => (
        <button
          key={String(model.id)}
          type="button"
          onClick={() => onModelChange(model)}
        >
          pick {model.name}
        </button>
      ))}
    </div>
  ),
}));

const GPT5_SELECTION = {
  modelId: "openai/gpt-5",
  source: "hosted" as const,
  fallback: { provider: "none" as const, model: "none" as const },
};

function setup(partial: Partial<HostConfigInputV2>) {
  const draft = { ...emptyHostConfigInputV2(), ...partial } as HostConfigInputV2;
  const onDraftChange = vi.fn();
  render(
    <TooltipProvider>
      <BehaviorTab draft={draft} onDraftChange={onDraftChange} attention={[]} />
    </TooltipProvider>,
  );
  const applied = () => {
    const updater = onDraftChange.mock.calls.at(-1)![0] as (
      prev: HostConfigInputV2,
    ) => HostConfigInputV2;
    return updater(draft);
  };
  return { applied, onDraftChange };
}

describe("BehaviorTab reasoning effort", () => {
  it("writes the effort onto the saved selection", async () => {
    models.supported = true;
    const { applied } = setup({
      modelId: "openai/gpt-5",
      modelSelection: GPT5_SELECTION as never,
    });
    await userEvent.click(screen.getByTestId("effort-control-trigger"));
    await userEvent.click(await screen.findByRole("radio", { name: "High" }));
    expect(applied().modelId).toBe("openai/gpt-5");
    expect(applied().modelSelection?.settings?.reasoningEffort).toBe("high");
  });

  it("keeps the effort on a model that supports it and says so", async () => {
    models.supported = true;
    const { applied } = setup({
      modelId: "openai/gpt-5",
      modelSelection: {
        ...GPT5_SELECTION,
        settings: { reasoningEffort: "low" },
      } as never,
    });
    await userEvent.click(
      screen.getByRole("button", { name: "pick Claude Haiku 4.5" }),
    );
    expect(applied().modelId).toBe("anthropic/claude-haiku-4.5");
    expect(applied().modelSelection?.settings?.reasoningEffort).toBe("low");
    expect(screen.getByText("Kept Low effort.")).toBeInTheDocument();
  });

  it("clears the effort on a model that does not support it and says so", async () => {
    models.supported = true;
    const { applied } = setup({
      modelId: "openai/gpt-5",
      modelSelection: {
        ...GPT5_SELECTION,
        settings: { reasoningEffort: "high" },
      } as never,
    });
    await userEvent.click(screen.getByRole("button", { name: "pick GPT-4o" }));
    expect(applied().modelId).toBe("openai/gpt-4o");
    expect(applied().modelSelection?.settings).toBeUndefined();
    expect(
      screen.getByText(/High effort was cleared: GPT-4o doesn't support it/),
    ).toBeInTheDocument();
  });

  it("badges a saved effort the catalog no longer lists", () => {
    models.supported = true;
    setup({
      modelId: "openai/gpt-5",
      modelSelection: {
        ...GPT5_SELECTION,
        settings: { reasoningEffort: "max" },
      } as never,
    });
    expect(screen.getByTestId("effort-control-trigger")).toHaveTextContent(
      "no longer supported",
    );
  });

  it("shows nothing on a harness host with no effort saved", () => {
    models.supported = true;
    setup({ modelId: "openai/gpt-5", harness: "claude-code" });
    expect(screen.queryByTestId("effort-control-trigger")).toBeNull();
    expect(screen.queryByText("Reasoning effort")).toBeNull();
    expect(screen.queryByText(/doesn't support a reasoning effort/)).toBeNull();
  });

  it("shows a saved effort a harness refuses, with the note, and lets it be cleared", async () => {
    models.supported = true;
    const { applied } = setup({
      modelId: "openai/gpt-5",
      harness: "claude-code",
      modelSelection: {
        ...GPT5_SELECTION,
        settings: { reasoningEffort: "high" },
      } as never,
    });
    expect(screen.getByTestId("effort-control-trigger")).toHaveTextContent(
      "no longer supported",
    );
    expect(
      screen.getByText(/Claude Code doesn't support a reasoning effort yet/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("effort-control-trigger"));
    await userEvent.click(
      await screen.findByRole("radio", { name: "Default" }),
    );
    expect(applied().modelSelection?.settings).toBeUndefined();
  });

  it("renders no row for a model with no effort levels and nothing saved", () => {
    models.supported = true;
    setup({ modelId: "openai/gpt-4o" });
    expect(screen.queryByText("Reasoning effort")).toBeNull();
  });

  it("is disabled where the deployment stores no selections", () => {
    models.supported = false;
    setup({ modelId: "openai/gpt-5" });
    expect(screen.getByTestId("effort-control-trigger")).toBeDisabled();
  });
});
