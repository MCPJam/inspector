import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

async function toggle(part: string) {
  const user = userEvent.setup();
  const group = screen.getByRole("toolbar", { name: LABEL });
  await user.click(within(group).getByRole("button", { name: part }));
}

function selectedParts() {
  const group = screen.getByRole("toolbar", { name: LABEL });
  return within(group)
    .getAllByRole("button", { pressed: true })
    .map((button) => button.textContent);
}

describe("BehaviorTab tool results sent to the model", () => {
  it("selects all three parts for a client with no rule", () => {
    renderTab(imageFlags);
    expect(selectedParts()).toEqual(["content", "structuredContent", "_meta"]);
    expect(
      screen.getByText(
        "The model gets content, structuredContent and _meta as one escaped JSON string.",
      ),
    ).toBeInTheDocument();
  });

  it.each([
    ["_meta", "both", ["content", "structuredContent"], /each once/],
    [
      "content",
      "preferred",
      ["structuredContent"],
      /or content when there is none/,
    ],
    [
      "structuredContent",
      "fallback",
      ["content"],
      /or structuredContent when content is empty/,
    ],
  ] as const)(
    "deselecting %s from the default stores %s and keeps the image flags",
    async (part, rule, parts, description) => {
      const { lastPolicy } = renderTab(imageFlags);
      await toggle(part);
      expect(lastPolicy()).toEqual({ ...imageFlags, structuredContent: rule });
      expect(selectedParts()).toEqual(parts);
      expect(screen.getByText(description)).toBeInTheDocument();
    },
  );

  it("selecting _meta selects all three and removes only the rule", async () => {
    const { lastPolicy } = renderTab({
      ...imageFlags,
      structuredContent: "preferred",
    });
    expect(selectedParts()).toEqual(["structuredContent"]);
    await toggle("_meta");
    expect(selectedParts()).toEqual(["content", "structuredContent", "_meta"]);
    expect(lastPolicy()).toEqual(imageFlags);
    expect(lastPolicy()).not.toHaveProperty("structuredContent");
  });

  it("going back to the default clears a policy that held only the rule", async () => {
    const { lastPolicy, drafts } = renderTab({ structuredContent: "both" });
    await toggle("_meta");
    expect(drafts.length).toBeGreaterThan(0);
    expect(lastPolicy()).toBeUndefined();
  });

  it("selecting a second part sends both", async () => {
    const { lastPolicy } = renderTab({ structuredContent: "fallback" });
    await toggle("structuredContent");
    expect(lastPolicy()).toEqual({ structuredContent: "both" });
    expect(selectedParts()).toEqual(["content", "structuredContent"]);
  });

  it("keeps the last selected part", async () => {
    const { drafts } = renderTab({ structuredContent: "fallback" });
    await toggle("content");
    expect(drafts).toHaveLength(0);
    expect(selectedParts()).toEqual(["content"]);
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
      screen.queryByRole("toolbar", { name: LABEL }),
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
    const group = screen.getByRole("toolbar", { name: LABEL });
    for (const button of within(group).getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });
});
