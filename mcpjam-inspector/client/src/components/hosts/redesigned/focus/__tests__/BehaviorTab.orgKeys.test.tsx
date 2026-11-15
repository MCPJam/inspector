import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import type { ModelDefinition } from "@/shared/types";
import { BehaviorTab } from "../BehaviorTab";

const ORG_LUNA = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  provider: "openai",
  hosted: false,
  orgProvider: { providerKey: "openai", id: "orgprov_openai" },
} as ModelDefinition;

const hook = vi.hoisted(() => ({ modelSelectionsSupported: true }));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({
    availableModels: [ORG_LUNA],
    modelSelectionsSupported: hook.modelSelectionsSupported,
    requireOrgKeys: true,
    onAddProvider: null,
  }),
}));
vi.mock("@/hooks/useHarnessCapabilities", () => ({
  useHarnessCapabilities: () => ({ capabilities: undefined, loading: false }),
}));
type PickerProps = {
  disabled?: boolean;
  onModelChange: (model: ModelDefinition) => void;
};
const picker = vi.hoisted(() => ({ props: null as PickerProps | null }));
vi.mock("@/components/chat-v2/chat-input/model-selector", () => ({
  ModelSelector: (props: PickerProps) => {
    picker.props = props;
    return null;
  },
}));

function renderTab(onDraftChange = vi.fn()) {
  render(
    <TooltipProvider>
      <BehaviorTab
        draft={emptyHostConfigInputV2() as HostConfigInputV2}
        onDraftChange={onDraftChange}
        attention={[]}
      />
    </TooltipProvider>,
  );
  return onDraftChange;
}

describe("BehaviorTab model picker under the organization key policy", () => {
  beforeEach(() => {
    picker.props = null;
  });

  it("is disabled and ignores picks when the deployment stores no selections", () => {
    hook.modelSelectionsSupported = false;
    const onDraftChange = renderTab();
    expect(picker.props?.disabled).toBe(true);
    picker.props?.onModelChange(ORG_LUNA);
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("saves the org selection when the deployment stores selections", () => {
    hook.modelSelectionsSupported = true;
    const onDraftChange = renderTab();
    expect(picker.props?.disabled).toBe(false);
    picker.props?.onModelChange(ORG_LUNA);
    expect(onDraftChange).toHaveBeenCalled();
  });
});
