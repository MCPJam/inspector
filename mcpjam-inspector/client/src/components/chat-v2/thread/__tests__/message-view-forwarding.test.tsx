import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MessageView } from "../message-view";
const { rendered } = vi.hoisted(() => ({ rendered: vi.fn() }));
vi.mock("../part-switch", () => ({
  PartSwitch: (props: {
    part: { type: string };
    onForwardingToolApprovalResponse?: unknown;
  }) => {
    rendered(props);
    return <span>{props.part.type}</span>;
  },
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: string }) => unknown) =>
    selector({ themeMode: "light" }),
}));
vi.mock("@/contexts/scenario-client-style-context", () => ({
  useScenarioHostStyle: () => null,
  useScenarioHostTheme: () => null,
}));
beforeEach(() => rendered.mockClear());
const base = (): ComponentProps<typeof MessageView> => ({
  message: {
    id: "message",
    role: "assistant",
    parts: [{ type: "text", text: "before" }],
  },
  model: {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude",
    provider: "anthropic",
  },
  onSendFollowUp: vi.fn(),
  toolsMetadata: {},
  toolServerMap: {},
  pipWidgetId: null,
  fullscreenWidgetId: null,
  onRequestPip: vi.fn(),
  onExitPip: vi.fn(),
  onRequestFullscreen: vi.fn(),
  onExitFullscreen: vi.fn(),
});
describe("streaming forwarding approvals", () => {
  it("renders an appended gate card even when the stream mutates the message in place", () => {
    const props = base();
    const reply = vi.fn();
    const { rerender } = render(
      <MessageView
        {...props}
        isStreaming
        onForwardingToolApprovalResponse={reply}
      />,
    );
    props.message.parts.push({
      type: "tool-approval-card",
      toolCallId: "gate",
      state: "approval-requested",
      approval: { id: "mjfg1:gate" },
      input: {},
    });
    rerender(
      <MessageView
        {...props}
        isStreaming
        onForwardingToolApprovalResponse={reply}
      />,
    );
    expect(screen.getByText("tool-approval-card")).toBeInTheDocument();
    expect(rendered.mock.lastCall?.[0].onForwardingToolApprovalResponse).toBe(
      reply,
    );
  });
  it("retains memoization for an unchanged completed message", () => {
    const props = base();
    const { rerender } = render(<MessageView {...props} />);
    const count = rendered.mock.calls.length;
    rerender(<MessageView {...props} />);
    expect(rendered).toHaveBeenCalledTimes(count);
  });
});
