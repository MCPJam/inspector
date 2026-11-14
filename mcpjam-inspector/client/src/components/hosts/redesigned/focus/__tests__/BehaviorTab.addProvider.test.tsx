import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { BehaviorTab } from "../BehaviorTab";

const hook = vi.hoisted(() => ({
  onAddProvider: null as (() => void) | null,
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({
    availableModels: [],
    modelSelectionsSupported: true,
    onAddProvider: hook.onAddProvider,
  }),
}));
vi.mock("@/hooks/useHarnessCapabilities", () => ({
  useHarnessCapabilities: () => ({ capabilities: undefined, loading: false }),
}));
const picker = vi.hoisted(() => ({ onAddProvider: vi.fn() }));
vi.mock("@/components/chat-v2/chat-input/model-selector", () => ({
  ModelSelector: ({ onAddProvider }: { onAddProvider: unknown }) => {
    picker.onAddProvider(onAddProvider);
    return null;
  },
}));

function renderTab() {
  render(
    <TooltipProvider>
      <BehaviorTab
        draft={emptyHostConfigInputV2() as HostConfigInputV2}
        onDraftChange={() => {}}
        attention={[]}
      />
    </TooltipProvider>,
  );
}

describe("BehaviorTab model picker", () => {
  beforeEach(() => picker.onAddProvider.mockClear());

  it("hands the picker the active project's Add a provider", () => {
    const handoff = vi.fn();
    hook.onAddProvider = handoff;
    renderTab();
    expect(picker.onAddProvider).toHaveBeenLastCalledWith(handoff);
  });

  it("passes null when the viewer can't add providers there", () => {
    hook.onAddProvider = null;
    renderTab();
    expect(picker.onAddProvider).toHaveBeenLastCalledWith(null);
  });
});
