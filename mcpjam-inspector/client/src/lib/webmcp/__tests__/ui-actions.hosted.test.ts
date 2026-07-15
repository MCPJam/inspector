import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeInspectorCommandMock } = vi.hoisted(() => ({
  executeInspectorCommandMock: vi.fn(),
}));

vi.mock("@/lib/inspector-command-handlers", () => ({
  executeInspectorCommand: executeInspectorCommandMock,
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

import {
  listUiNavigationTargets,
  navigateAction,
  resolveUiNavigationTarget,
} from "../ui-actions";
import { HOSTED_HASH_BLOCKED_TABS } from "@/lib/hosted-tab-policy";

describe("ui-actions (hosted mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("excludes hosted-blocked tabs from the advertised targets", () => {
    const targets = listUiNavigationTargets();
    expect(HOSTED_HASH_BLOCKED_TABS.length).toBeGreaterThan(0);
    for (const blocked of HOSTED_HASH_BLOCKED_TABS) {
      expect(targets).not.toContain(blocked);
    }
    expect(targets).toContain("playground");
    expect(targets).toContain("servers");
  });

  it("rejects hosted-blocked targets with a clear reason", () => {
    const result = resolveUiNavigationTarget("tracing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('"tracing" is not available in hosted mode');
    }
  });

  it("navigateAction never dispatches a blocked target", async () => {
    const result = await navigateAction("tasks");
    expect(result.ok).toBe(false);
    expect(executeInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("still resolves allowed tabs", () => {
    expect(resolveUiNavigationTarget("evals")).toMatchObject({
      ok: true,
      path: "/evals",
    });
  });
});
