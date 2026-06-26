import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PromptTurn } from "@/shared/steps";

// RenderPreviewPanel pulls in the widget renderer (widget-react/sandbox); stub it
// so this test stays focused on the auto-derived interaction-check slots.
vi.mock("../render-preview-panel", () => ({
  RenderPreviewPanel: () => null,
}));

// UserMessageBubble depends on PreferencesStoreProvider — stub it (the prompt
// bubble is irrelevant to the widget-check slots under test).
vi.mock("@/components/chat-v2/thread/user-message-bubble", () => ({
  UserMessageBubble: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { ExpectedConversation } from "../preview/expected-conversation";

const turn = (over: Partial<PromptTurn> = {}): PromptTurn => ({
  id: "t1",
  prompt: "Draw a dog",
  expectedToolCalls: [],
  ...over,
});

describe("ExpectedConversation — auto-derived widget-check slots", () => {
  it("hides an empty model-driven widget slot before a run (progressive disclosure)", () => {
    render(
      <ExpectedConversation
        promptTurns={[
          turn({ expectedToolCalls: [{ toolName: "create_view", arguments: {} }] }),
        ]}
        onUpdateTurn={vi.fn()}
        widgetToolNames={["create_view"]}
        widgetChecksEnabled
      />,
    );
    // No recorded steps yet → no empty "Add step" card up front; authoring
    // happens on the live widget after Run.
    expect(screen.queryByTestId("widget-check-slot")).toBeNull();
  });

  it("shows a slot for a widget tool that already has recorded steps", () => {
    render(
      <ExpectedConversation
        promptTurns={[
          turn({
            expectedToolCalls: [{ toolName: "create_view", arguments: {} }],
            widgetChecks: [
              {
                toolName: "create_view",
                steps: [{ kind: "click", target: { testId: "canvas" } }],
              },
            ],
          }),
        ]}
        onUpdateTurn={vi.fn()}
        widgetToolNames={["create_view"]}
        widgetChecksEnabled
      />,
    );
    const slots = screen.getAllByTestId("widget-check-slot");
    expect(slots).toHaveLength(1);
    expect(slots[0]).toHaveTextContent("create_view");
  });

  it("shows no slot for a non-widget tool", () => {
    render(
      <ExpectedConversation
        promptTurns={[
          turn({ expectedToolCalls: [{ toolName: "read_me", arguments: {} }] }),
        ]}
        onUpdateTurn={vi.fn()}
        widgetToolNames={["create_view"]}
        widgetChecksEnabled
      />,
    );
    expect(screen.queryByTestId("widget-check-slot")).toBeNull();
  });

  it("does not render slots when widget checks are disabled", () => {
    render(
      <ExpectedConversation
        promptTurns={[
          turn({ expectedToolCalls: [{ toolName: "create_view", arguments: {} }] }),
        ]}
        onUpdateTurn={vi.fn()}
        widgetToolNames={["create_view"]}
        widgetChecksEnabled={false}
      />,
    );
    expect(screen.queryByTestId("widget-check-slot")).toBeNull();
  });

  it("appends a step into an existing group via onUpdateTurn", () => {
    const onUpdateTurn = vi.fn();
    const seeded = { kind: "click", target: { testId: "canvas" } } as const;
    const t = turn({
      expectedToolCalls: [{ toolName: "create_view", arguments: {} }],
      widgetChecks: [{ toolName: "create_view", steps: [seeded] }],
    });
    render(
      <ExpectedConversation
        promptTurns={[t]}
        onUpdateTurn={onUpdateTurn}
        widgetToolNames={["create_view"]}
        widgetChecksEnabled
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /add step/i }));
    expect(onUpdateTurn).toHaveBeenCalledTimes(1);
    const [index, updater] = onUpdateTurn.mock.calls[0]!;
    expect(index).toBe(0);
    // Applying the updater appends a default step after the recorded one.
    const next = updater(t);
    expect(next.widgetChecks).toEqual([
      {
        toolName: "create_view",
        steps: [seeded, { kind: "click", target: { testId: "" } }],
      },
    ]);
  });
});
