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
  // Carries `disabled` through: it is the prop the harness gating decides, and
  // a stub that swallowed it would let the model selector silently un-gate.
  ModelSelector: ({ disabled }: { disabled?: boolean }) => (
    <div
      data-testid="model-selector"
      data-disabled={disabled ? "true" : undefined}
    />
  ),
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
    // (no blanket isHarnessHost disable). Claude Code's model credentials are
    // brokered by MCPJam, so the selection is what the runtime launches with.
    expect(screen.getByTestId("model-selector")).not.toHaveAttribute(
      "data-disabled",
    );
    expect(
      screen.getByPlaceholderText(/helpful assistant/i),
    ).not.toHaveAttribute("readonly");
  });

  it("leaves approval EDITABLE for claude-code now that its proxy phase landed", () => {
    // The adapter bridge's `canUseTool` gates every surface — built-ins,
    // host-executed tools, and (under `approvalPermissionMode: "allow-reads"`)
    // the MCP tools the in-sandbox client calls — so `requireToolApproval` is
    // enforced for claude-code (#4531) and the switch must not gray out or
    // carry the old "refused rather than run unapproved" note.
    renderBehaviorTab({ harness: "claude-code" });

    expect(
      screen.getByRole("switch", { name: /require tool approval/i }),
    ).toBeEnabled();
    expect(
      screen.queryByText(/refused rather than run unapproved/i),
    ).not.toBeInTheDocument();
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

  it("leaves tool visibility EDITABLE for a codex host, with no stale warning", () => {
    // Codex delivers the host's MCP servers as host-executed tools that MCPJam
    // builds itself, under the host's own options — so `respectToolVisibility`
    // reaches them (COMP-39). The switch stayed disabled after that landed,
    // blocking the user from a setting that works and explaining it with a
    // reason that was no longer true.
    renderBehaviorTab({ harness: "codex" });

    expect(
      screen.getByRole("switch", { name: /respect tool visibility/i }),
    ).toBeEnabled();
    expect(
      screen.queryByText(/can't filter its tool list/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/not enforced for the codex harness/i),
    ).not.toBeInTheDocument();

    // The controls Codex genuinely can't honor are still gated — this is not a
    // blanket un-graying. Their note says the turn is REFUSED, which is what
    // actually happens; "not enforced" described an outcome (run anyway,
    // unapproved) the pre-flight never produces.
    expect(
      screen.getByRole("switch", { name: /require tool approval/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/refused rather than run unapproved/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/codex does its own tool discovery/i),
    ).toBeInTheDocument();
  });

  it("keeps tool visibility gated for claude-code, which lists tools in-sandbox", () => {
    renderBehaviorTab({ harness: "claude-code" });

    expect(
      screen.getByRole("switch", { name: /respect tool visibility/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/connects to MCP servers itself/i),
    ).toBeInTheDocument();
  });

  it("disables the MODEL selector for a cursor harness host, and says who chooses", () => {
    // The one harness whose model is not MCPJam's to choose: it authenticates
    // with the customer's own Cursor account and that account picks the model.
    // Left enabled, a selection persists onto the host and reaches nothing —
    // the host then displays a model that never ran.
    const { container } = renderBehaviorTab({ harness: "cursor" });

    expect(screen.getByTestId("model-selector")).toHaveAttribute(
      "data-disabled",
      "true",
    );
    expect(
      screen.getByText(/Cursor account, which chooses the model itself/i),
    ).toBeInTheDocument();

    // Temperature goes with it, for the same reason.
    expect(sliderRoot(container)).toHaveAttribute("data-disabled");

    // NOT a blanket harness disable: the ACP bridge really does pause on its
    // native tools, so approval stays editable and carries no stale note.
    expect(
      screen.getByRole("switch", { name: /require tool approval/i }),
    ).toBeEnabled();
    expect(
      screen.queryByText(/refused rather than run unapproved/i),
    ).not.toBeInTheDocument();
  });

  it("leaves every control enabled for an emulated (no-harness) host", () => {
    const { container } = renderBehaviorTab();

    // Includes the emulated `cursor` host style — the IDE chat panel carries no
    // harness and picks its model normally. Only the CLI runtime is gated.
    expect(screen.getByTestId("model-selector")).not.toHaveAttribute(
      "data-disabled",
    );
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
