import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
  type ModelVisibleMcpToolResults,
} from "@/lib/client-config-v2";
import { BehaviorTab } from "../BehaviorTab";

// The model picker and harness capability hooks need providers; stub them so
// the test stays on the tool-result control.
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));
vi.mock("@/hooks/useHarnessCapabilities", () => ({
  useHarnessCapabilities: () => ({ capabilities: undefined, loading: false }),
}));
vi.mock("@/components/chat-v2/chat-input/model-selector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));

const LABEL = "Tool results sent to the model";

const imageFlags: ModelVisibleMcpToolResults = {
  directContent: { image: false },
  linkedResources: { blob: { image: false } },
};

function StatefulBehaviorTab({
  initial,
  onDraft,
}: {
  initial: HostConfigInputV2;
  onDraft: (draft: HostConfigInputV2) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <BehaviorTab
      draft={draft}
      onDraftChange={(updater) =>
        setDraft((prev) => {
          const next = updater(prev);
          onDraft(next);
          return next;
        })
      }
      attention={[]}
    />
  );
}

function renderTab(policy: ModelVisibleMcpToolResults | undefined) {
  const drafts: HostConfigInputV2[] = [];
  render(
    <StatefulBehaviorTab
      initial={{
        ...emptyHostConfigInputV2(),
        modelVisibleMcpToolResults: policy,
      }}
      onDraft={(draft) => drafts.push(draft)}
    />,
  );
  return {
    lastPolicy: () => drafts.at(-1)?.modelVisibleMcpToolResults,
    drafts,
  };
}

async function pick(option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: LABEL }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("BehaviorTab tool results sent to the model", () => {
  it("shows the default for a client with no rule", () => {
    renderTab(imageFlags);
    expect(screen.getByRole("combobox", { name: LABEL })).toHaveTextContent(
      "Combined JSON (default)",
    );
    expect(
      screen.getByText(
        "Sends text, structured content and _meta together as one JSON string.",
      ),
    ).toBeInTheDocument();
  });

  it.each([
    [
      "Prefer text",
      "fallback",
      /only when there is no text, like Claude Desktop/,
    ],
    [
      "Prefer structured content",
      "preferred",
      /only when there is no structured content, like Claude Code and Codex CLI/,
    ],
    ["Text and structured content", "both", /once each/],
  ] as const)(
    "picking %s stores %s and keeps the image flags",
    async (option, rule, description) => {
      const { lastPolicy } = renderTab(imageFlags);
      await pick(option);
      expect(lastPolicy()).toEqual({ ...imageFlags, structuredContent: rule });
      expect(screen.getByText(description)).toBeInTheDocument();
    },
  );

  it("picking the default removes only the rule", async () => {
    const { lastPolicy } = renderTab({
      ...imageFlags,
      structuredContent: "preferred",
    });
    expect(screen.getByRole("combobox", { name: LABEL })).toHaveTextContent(
      "Prefer structured content",
    );
    await pick("Combined JSON (default)");
    expect(lastPolicy()).toEqual(imageFlags);
    expect(lastPolicy()).not.toHaveProperty("structuredContent");
  });

  it("picking the default clears a policy that held only the rule", async () => {
    const { lastPolicy, drafts } = renderTab({ structuredContent: "both" });
    await pick("Combined JSON (default)");
    expect(drafts.length).toBeGreaterThan(0);
    expect(lastPolicy()).toBeUndefined();
  });

  it.each([
    ["a harness", { harness: "claude-code" }],
    ["an agent loop", { agentLoop: "codex" }],
  ] as const)("is hidden on %s client", (_kind, selector) => {
    render(
      <BehaviorTab
        draft={{
          ...emptyHostConfigInputV2(),
          ...selector,
          modelVisibleMcpToolResults: { structuredContent: "preferred" },
        }}
        onDraftChange={vi.fn()}
        attention={[]}
      />,
    );
    // The neighboring image controls still render, so the tab itself did.
    expect(
      screen.getByRole("radiogroup", { name: "Render tool images" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: LABEL }),
    ).not.toBeInTheDocument();
  });

  it("is disabled when the tab is read-only", () => {
    render(
      <BehaviorTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        readOnly
      />,
    );
    expect(screen.getByRole("combobox", { name: LABEL })).toBeDisabled();
  });
});
