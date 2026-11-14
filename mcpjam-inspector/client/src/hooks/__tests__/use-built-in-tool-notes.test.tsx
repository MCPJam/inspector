import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ current: undefined as unknown }));
const scope = vi.hoisted(() => ({ projectId: undefined as unknown }));

vi.mock("@/hooks/use-hosted-org-model-config", () => ({
  useHostedOrgModelConfig: (args: { projectId?: string | null }) => {
    scope.projectId = args.projectId;
    return config.current;
  },
  loadedOrgModelConfig: (value: { pending?: boolean } | undefined) =>
    value && !value.pending ? value : undefined,
}));

import { useBuiltInToolNotes } from "../use-built-in-tool-notes";

const strict = (status: string) => ({
  providers: [],
  aiKeyPolicy: { requireOrgKeys: true },
  aiReadiness: {
    requireOrgKeys: true,
    features: [],
    operations: [{ operation: "web_search", status }],
    eligibleConnectionIds: [],
  },
});

describe("useBuiltInToolNotes", () => {
  it("notes web search for the project's organization when it can't run", () => {
    config.current = strict("unsupported");
    const { result } = renderHook(() => useBuiltInToolNotes("project-1"));
    expect(scope.projectId).toBe("project-1");
    expect(result.current.web_search).toContain(
      "Web search can't run on them yet.",
    );
  });

  it("notes nothing while loading, without a policy, or once search runs", () => {
    config.current = { providers: [], pending: true };
    expect(renderHook(() => useBuiltInToolNotes("p")).result.current).toEqual(
      {},
    );
    config.current = undefined;
    expect(renderHook(() => useBuiltInToolNotes("p")).result.current).toEqual(
      {},
    );
    config.current = strict("ready");
    expect(renderHook(() => useBuiltInToolNotes("p")).result.current).toEqual(
      {},
    );
  });
});
