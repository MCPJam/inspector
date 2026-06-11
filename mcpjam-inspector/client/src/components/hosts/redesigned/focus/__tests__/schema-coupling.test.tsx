import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import { hostConfigField } from "@/lib/host-config-field-schema";

// BehaviorTab subscribes to the built-in tools catalog via Convex; stub it.
vi.mock("@/hooks/useBuiltInToolCatalog", () => ({
  useBuiltInToolCatalog: () => [],
}));

// BehaviorTab's model picker reuses the Playground ModelSelector fed by the
// shared app-state + Convex model hooks; stub them so the tab renders
// without providers.
vi.mock("@/hooks/use-host-agent-models", () => ({
  useHostAgentModels: () => ({
    availableModels: [
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
    ],
  }),
}));
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
  useFeatureFlagEnabled: () => false,
}));
vi.mock("@/components/chat-v2/chat-input/model/provider-logo", () => ({
  ProviderLogo: ({ provider }: { provider: string }) => (
    <span aria-hidden="true">{provider}</span>
  ),
}));

import { BehaviorTab } from "../BehaviorTab";

/**
 * Coupling test: the focus tabs read their labels and descriptions from
 * the shared `host-config-field-schema`, not inline strings. If someone
 * renames `temperature.label` in the schema, this test fails first and
 * the tab catches up automatically — that's the contract being asserted.
 *
 * BehaviorTab is the proof of the pattern (most fields per tab). The
 * minor ProtocolTab + AppsExtensionTab couplings are covered by the
 * schema's `hostConfigField()` throw-on-typo guard at call site.
 */
describe("BehaviorTab consumes labels from the shared schema", () => {
  function renderTab() {
    render(
      <BehaviorTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
      />,
    );
  }

  it("renders the schema label for `temperature`", () => {
    renderTab();
    const label = hostConfigField("temperature").label;
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it("renders the schema label for `requireToolApproval`", () => {
    renderTab();
    const label = hostConfigField("requireToolApproval").label;
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it("renders the schema label for `respectToolVisibility`", () => {
    renderTab();
    const label = hostConfigField("respectToolVisibility").label;
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it("renders the schema label for `progressiveToolDiscovery`", () => {
    renderTab();
    const label = hostConfigField("progressiveToolDiscovery").label;
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it("renders the schema label for `systemPrompt` (FocusBlock title)", () => {
    renderTab();
    const label = hostConfigField("systemPrompt").label;
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it("renders the schema description for `requireToolApproval`", () => {
    renderTab();
    const desc = hostConfigField("requireToolApproval").description!;
    expect(screen.getAllByText(desc).length).toBeGreaterThan(0);
  });
});
