import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";

// BehaviorTab subscribes to the built-in tools catalog via Convex; stub the
// hook so tests don't need a ConvexProvider. Empty list keeps the new
// Built-in tools FocusBlock hidden, which is the right default here.
vi.mock("@/hooks/useBuiltInToolCatalog", () => ({
  useBuiltInToolCatalog: () => [],
}));

// The model picker reuses the Playground ModelSelector fed by the shared
// app-state + Convex model hooks; stub them so the tab renders without
// providers.
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
import { ProtocolTab } from "../ProtocolTab";
import { AppsExtensionTab } from "../AppsExtensionTab";

/**
 * Phase 2 of the per-attachment-server-selection plan adds a `readOnly`
 * prop to each Client editor tab so the new AttachmentEditor (Phase 3)
 * can surface the host's profile without letting users edit it inline.
 *
 * These tests are minimal — they verify the prop is wired and the most
 * visible control on each tab respects it. Deeper readOnly behavior
 * (capability-matrix sub-toggles, JSON view-mode forcing) gets exercised
 * organically by HostFocusPanel.test.tsx and downstream callers once
 * Phase 3 sets readOnly={true} on a real surface.
 */
describe("Client editor tabs — readOnly prop wiring", () => {
  it("BehaviorTab readOnly disables the model select", () => {
    render(
      <BehaviorTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        readOnly
      />,
    );
    // Empty draft modelId renders the picker trigger as "Select model".
    const modelTrigger = screen.getByRole("button", {
      name: /select model/i,
    });
    expect(modelTrigger).toBeDisabled();
  });

  it("BehaviorTab readOnly disables the system-prompt textarea", () => {
    render(
      <BehaviorTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        readOnly
      />,
    );
    const textarea = screen.getByPlaceholderText(
      "You are a helpful assistant…",
    ) as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute("readonly");
  });

  it("BehaviorTab readOnly disables tool-approval and visibility switches", () => {
    render(
      <BehaviorTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        readOnly
      />,
    );
    const approval = screen.getByRole("switch", {
      name: /require tool approval/i,
    });
    const visibility = screen.getAllByRole("switch", {
      name: /respect tool visibility/i,
    })[0];
    expect(approval).toBeDisabled();
    expect(visibility).toBeDisabled();
  });

  it("BehaviorTab without readOnly leaves controls enabled (sanity check)", () => {
    render(
      <BehaviorTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
      />,
    );
    const modelTrigger = screen.getByRole("button", {
      name: /select model/i,
    });
    expect(modelTrigger).not.toBeDisabled();
  });

  it("AppsExtensionTab readOnly wraps the body in a disabled fieldset", () => {
    const { container } = render(
      <AppsExtensionTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        readOnly
      />,
    );
    const fieldset = container.querySelector("fieldset");
    expect(fieldset).not.toBeNull();
    expect(fieldset).toBeDisabled();
  });

  it("AppsExtensionTab without readOnly renders an enabled fieldset", () => {
    const { container } = render(
      <AppsExtensionTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
      />,
    );
    const fieldset = container.querySelector("fieldset");
    expect(fieldset).not.toBeNull();
    expect(fieldset).not.toBeDisabled();
  });

  it("ProtocolTab accepts the readOnly prop without throwing", () => {
    // ProtocolTab gates Select via `disabled` and forces JsonEditor to
    // `mode="view"` + `readOnly={true}`. Direct interaction with the
    // CodeMirror-backed JsonEditor is brittle in JSDOM, so this test
    // verifies the prop wiring lands cleanly without asserting on the
    // editor's internal state.
    expect(() =>
      render(
        <ProtocolTab
          draft={emptyHostConfigInputV2()}
          onDraftChange={vi.fn()}
          attention={[]}
          readOnly
        />,
      ),
    ).not.toThrow();
  });
});
