import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// The control is gated on the `mcp-tasks` flag, with a WIDER escape hatch than
// the XAA policy above it: XAA re-renders when its state is `!== "off"`
// because "off" doubles as absent there, whereas this policy has a real
// explicit-off state that must stay editable.
const { featureFlagMock } = vi.hoisted(() => ({
  featureFlagMock: vi.fn((_flag: string) => false),
}));
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
  useFeatureFlagEnabled: (flag: string) => featureFlagMock(flag),
}));
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import {
  MCPJAM_TASKS_POLICY_EXTENSION_ID,
  readTasksPolicy,
} from "@mcpjam/sdk/browser";
import { ProtocolTab } from "../ProtocolTab";

function renderTab(draft: HostConfigInputV2) {
  let latest = draft;
  const onDraftChange = vi.fn(
    (updater: (prev: HostConfigInputV2) => HostConfigInputV2) => {
      latest = updater(latest);
    },
  );
  const utils = render(
    <ProtocolTab draft={draft} onDraftChange={onDraftChange} attention={[]} />,
  );
  return { ...utils, onDraftChange, getDraft: () => latest };
}

function withPolicy(enabled: boolean | string): HostConfigInputV2 {
  const draft = emptyHostConfigInputV2();
  draft.mcpProfile = {
    profileVersion: 1,
    extensions: { [MCPJAM_TASKS_POLICY_EXTENSION_ID]: { enabled } },
  } as HostConfigInputV2["mcpProfile"];
  return draft;
}

const label = /task execution/i;

describe("ProtocolTab — tasks policy control", () => {
  it("is hidden with the flag off and no stored policy", () => {
    featureFlagMock.mockImplementation(() => false);
    renderTab(emptyHostConfigInputV2());
    expect(screen.queryByText(label)).toBeNull();
  });

  it("renders with the flag on", () => {
    featureFlagMock.mockImplementation((flag: string) => flag === "mcp-tasks");
    renderTab(emptyHostConfigInputV2());
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("STILL renders with the flag off when the host stored an explicit off", () => {
    // The stranding case. An explicitly-`off` host under a flag-off user would
    // otherwise have tasks disabled with no UI left to re-enable them — which
    // is why the gate tests `!== "unset"` rather than XAA's `!== "off"`.
    featureFlagMock.mockImplementation(() => false);
    renderTab(withPolicy(false));
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("still renders with the flag off when the stored value is malformed", () => {
    featureFlagMock.mockImplementation(() => false);
    renderTab(withPolicy("yes"));
    expect(screen.getByText(label)).toBeTruthy();
    // The repair warning, not a silent snap to "Use default".
    expect(screen.getByText(/must be true or false/i)).toBeTruthy();
  });

  it("reads unset for a host that never opted in", () => {
    // The zero-churn guarantee at the read level: an untouched host is `unset`,
    // which every surface resolves to today's behavior.
    expect(readTasksPolicy(emptyHostConfigInputV2())).toBe("unset");
  });
});
