import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ActionRow } from "../case-spine/action-row";
import type { ComponentProps } from "react";
import type { PinnedToolCallFields } from "@/components/evals/pinned-tool-call-fields";

let fields: ComponentProps<typeof PinnedToolCallFields>;
vi.mock("@/components/evals/pinned-tool-call-fields", () => ({
  PinnedToolCallFields: (props: typeof fields) => { fields = props; return null; },
}));
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));

const step = { id: "call", kind: "toolCall" as const, serverId: "server-id", serverName: "srv", toolName: "view", arguments: {}, renderTimeoutMs: 1000 };
const mount = (readOnly = false, isActive = false) => {
  const onUpdate = vi.fn();
  render(<ActionRow action={{ step, ordinal: 1, checks: [] } as never} total={1} status={undefined}
    isActive={isActive} readOnly={readOnly} availableTools={[]} suiteServers={["srv"]}
    promptAriaLabel="Prompt" onUpdate={onUpdate} onMove={vi.fn()} onRemove={vi.fn()} canRemove defaultOpen>{null}</ActionRow>);
  return onUpdate;
};

describe("pinned tool field updates", () => {
  it("keeps hover feedback on individual controls instead of the action wrapper", () => {
    mount(false, true);
    const row = screen.getByTestId("spine-action-row");
    expect(row).not.toHaveClass("ring-1", "ring-ring", "ring-border");
    expect(screen.getByRole("button", { name: "Edit step 1" })).toHaveClass("hover:bg-muted/50");
  });
  it("ignores mount-time normalization in a frozen view", () => {
    const onUpdate = mount(true);
    act(() => fields.onChange({ serverName: "srv", toolName: "view", arguments: {} }));
    expect(onUpdate).not.toHaveBeenCalled();
  });
  it("preserves the stable server id and clears an emptied timeout", () => {
    const onUpdate = mount();
    act(() => fields.onChange({ serverName: "srv", toolName: "view", arguments: {} }));
    expect(onUpdate).toHaveBeenCalledWith({ ...step, renderTimeoutMs: undefined });
  });
  it("clears the old id when the author selects another server", () => {
    const onUpdate = mount();
    act(() => fields.onChange({ serverName: "other", toolName: "view", arguments: {} }));
    expect(onUpdate.mock.lastCall?.[0].serverId).toBeUndefined();
  });
});
