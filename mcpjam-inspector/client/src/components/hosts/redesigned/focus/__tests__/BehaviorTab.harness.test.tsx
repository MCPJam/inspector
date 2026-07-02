import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import { BehaviorTab } from "../BehaviorTab";

// BehaviorTab pulls the model picker through provider-backed hooks; stub them
// so the test stays focused on the harness gray-out wiring (the thing under
// test), not the model pipeline.
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));
vi.mock("@/components/chat-v2/chat-input/model-selector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));

function renderBehaviorTab(partial?: Parameters<typeof emptyHostConfigInputV2>[0]) {
  const draft = emptyHostConfigInputV2(partial);
  return render(
    <BehaviorTab draft={draft} onDraftChange={vi.fn()} attention={[]} />,
  );
}

// The Radix slider thumb (role="slider") doesn't inherit the root's
// aria-label; the disabled state lands as `data-disabled` on the root span
// (`data-slot="slider"`). Query that.
function sliderRoot(container: HTMLElement): Element {
  const el = container.querySelector('[data-slot="slider"]');
  if (!el) throw new Error("temperature slider not rendered");
  return el;
}

describe("BehaviorTab harness gray-out", () => {
  it("disables temperature for a claude-code harness host but not model/system prompt", () => {
    const { container } = renderBehaviorTab({ harness: "claude-code" });

    // Permanently not enforced for the harness → disabled with an honest note.
    expect(sliderRoot(container)).toHaveAttribute("data-disabled");
    expect(
      screen.getByText(/runs its own loop and ignores temperature/i),
    ).toBeInTheDocument();

    // Model + system prompt DO cross into the harness, so they stay editable
    // (no blanket isHarnessHost disable).
    expect(screen.getByTestId("model-selector")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/helpful assistant/i),
    ).not.toHaveAttribute("readonly");
  });

  it("disables approval / visibility until their proxy phase lands", () => {
    renderBehaviorTab({ harness: "claude-code" });

    expect(
      screen.getByRole("switch", { name: /require tool approval/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: /respect tool visibility/i }),
    ).toBeDisabled();
  });

  it("shows progressive discovery as off for harness hosts even if an old draft says on", () => {
    renderBehaviorTab({
      harness: "claude-code",
      progressiveToolDiscovery: true,
    });

    expect(
      screen.getByText(/claude code does its own tool discovery/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("On")).toHaveAttribute("data-state", "off");
    expect(screen.getByLabelText("Off")).toHaveAttribute("data-state", "on");
  });

  it("leaves every control enabled for an emulated (no-harness) host", () => {
    const { container } = renderBehaviorTab();

    expect(sliderRoot(container)).not.toHaveAttribute("data-disabled");
    expect(
      screen.getByRole("switch", { name: /require tool approval/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("switch", { name: /respect tool visibility/i }),
    ).toBeEnabled();
    expect(
      screen.queryByText(/runs its own loop and ignores temperature/i),
    ).not.toBeInTheDocument();
  });
});
