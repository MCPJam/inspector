import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import { useVisibleHostFocusTabs } from "../host-focus-tab-defs";

vi.mock("@/hooks/useBuiltInToolCatalog", () => ({
  useBuiltInToolCatalog: () => [],
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => true,
  useBrowserEnabled: () => false,
}));

const tabIds = (draft: ReturnType<typeof emptyHostConfigInputV2>) =>
  renderHook(() => useVisibleHostFocusTabs(draft)).result.current.map(
    (tab) => tab.id,
  );

describe("useVisibleHostFocusTabs", () => {
  it("shows the Computer tab for a client on MCPJam Harness", () => {
    expect(tabIds(emptyHostConfigInputV2())).toContain("computer");
  });

  it("hides it for a client on a native harness, whichever field names it", () => {
    expect(
      tabIds({ ...emptyHostConfigInputV2(), harness: "claude-code" }),
    ).not.toContain("computer");
    expect(
      tabIds({ ...emptyHostConfigInputV2(), agentLoop: "codex" }),
    ).not.toContain("computer");
  });
});
