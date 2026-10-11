import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import { BehaviorTab } from "../BehaviorTab";

// BehaviorTab pulls the model picker through provider-backed hooks; stub them
// so the test stays focused on the harness gray-out wiring (the thing under
// test), not the model pipeline.
const catalog = vi.hoisted(() => ({
  current: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: catalog.current }),
}));
// The approval switch now asks the server which transport a harness runs,
// because that answer is no longer a property of the harness name. Default the
// stub to "no answer" so every existing case still exercises the STATIC map;
// the two cases at the bottom override it.
const capabilitiesAnswer = vi.hoisted(() => ({
  current: undefined as { supportsNativeToolApproval: boolean } | undefined,
}));
vi.mock("@/hooks/useHarnessCapabilities", () => ({
  useHarnessCapabilities: () => ({
    capabilities: capabilitiesAnswer.current,
    loading: false,
  }),
}));
vi.mock("@/components/chat-v2/chat-input/model-selector", () => ({
  // Carries `disabled` through: it is the prop the harness gating decides, and
  // a stub that swallowed it would let the model selector silently un-gate.
  ModelSelector: ({
    disabled,
    availableModels,
  }: {
    disabled?: boolean;
    availableModels?: Array<{ id: string; orgProvider?: { id?: string } }>;
  }) => (
    <div
      data-testid="model-selector"
      data-disabled={disabled ? "true" : undefined}
      data-models={(availableModels ?? [])
        .map((m) => `${m.orgProvider?.id ?? "hosted"}:${m.id}`)
        .join(",")}
    />
  ),
}));

function renderBehaviorTab(
  partial?: Parameters<typeof emptyHostConfigInputV2>[0],
) {
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

    // Approval works on Codex's app-server adapter, so its switch is live too.
    // The controls Codex genuinely can't honor are still gated: this is not a
    // blanket un-graying.
    expect(
      screen.getByRole("switch", { name: /require tool approval/i }),
    ).toBeEnabled();
    expect(
      screen.queryByText(/refused rather than run unapproved/i),
    ).not.toBeInTheDocument();
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

describe("approval follows the server's answer about the runtime", () => {
  afterEach(() => {
    capabilitiesAnswer.current = undefined;
  });

  it("enables approval for codex before any server answer arrives", () => {
    // Codex runs on the app-server adapter everywhere, so the static map
    // already knows the switch works.
    capabilitiesAnswer.current = undefined;
    renderBehaviorTab({ harness: "codex" });
    expect(screen.getByLabelText(/require tool approval/i)).not.toBeDisabled();
  });

  it.each(["claude-code", "codex"] as const)(
    "never lets the server TAKE AWAY a control the static map allowed (%s)",
    (harness) => {
      // The override is one-directional on purpose: a stale or wrong server
      // answer must not be able to disable a switch that works.
      capabilitiesAnswer.current = { supportsNativeToolApproval: false };
      renderBehaviorTab({ harness });
      expect(screen.getByLabelText(/require tool approval/i)).not.toBeDisabled();
    },
  );
});

describe("the model list a harness host offers", () => {
  afterEach(() => {
    catalog.current = [];
  });

  const HOSTED_HAIKU = {
    id: "anthropic/claude-haiku-4.5",
    name: "Haiku",
    provider: "anthropic",
    hosted: true,
  };
  const HOSTED_GPT = {
    id: "openai/gpt-5-mini",
    name: "GPT-5 mini",
    provider: "openai",
    hosted: true,
  };
  const ORG_ANTHROPIC = {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    hosted: false,
    orgProvider: { providerKey: "anthropic", id: "orgprov_a" },
  };
  const ORG_OPENAI = {
    id: "gpt-5-mini",
    name: "GPT-5 mini",
    provider: "openai",
    hosted: false,
    orgProvider: { providerKey: "openai", id: "orgprov_o" },
  };

  it("a Claude Code host offers hosted rows and the org's Anthropic rows", () => {
    catalog.current = [HOSTED_HAIKU, HOSTED_GPT, ORG_ANTHROPIC, ORG_OPENAI];
    renderBehaviorTab({ harness: "claude-code" });
    expect(screen.getByTestId("model-selector")).toHaveAttribute(
      "data-models",
      "hosted:anthropic/claude-haiku-4.5,orgprov_a:claude-sonnet-4-5",
    );
  });

  it("a Codex host offers hosted rows and the org's OpenAI rows", () => {
    catalog.current = [HOSTED_HAIKU, HOSTED_GPT, ORG_ANTHROPIC, ORG_OPENAI];
    renderBehaviorTab({ harness: "codex" });
    expect(screen.getByTestId("model-selector")).toHaveAttribute(
      "data-models",
      "hosted:openai/gpt-5-mini,orgprov_o:gpt-5-mini",
    );
  });

  it("offers nothing — not the unfiltered list — when no row can run", () => {
    catalog.current = [ORG_OPENAI];
    renderBehaviorTab({ harness: "claude-code" });
    expect(screen.getByTestId("model-selector")).toHaveAttribute(
      "data-models",
      "",
    );
  });

  it("an emulated host still offers everything", () => {
    catalog.current = [HOSTED_HAIKU, ORG_OPENAI];
    renderBehaviorTab();
    expect(screen.getByTestId("model-selector")).toHaveAttribute(
      "data-models",
      "hosted:anthropic/claude-haiku-4.5,orgprov_o:gpt-5-mini",
    );
  });
});
