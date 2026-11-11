import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCursorModels } from "../use-cursor-models";
import type { CursorModelCatalog } from "@/lib/cursor-models";

const state = vi.hoisted(() => ({
  catalogs: new Map<string, CursorModelCatalog>(),
  queries: [] as unknown[],
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: (_ref: unknown, args: "skip" | { projectId: string }) => {
    state.queries.push(args);
    return args === "skip" ? undefined : state.catalogs.get(args.projectId);
  },
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
vi.mock("../use-is-member-actor", () => ({ useIsMemberActor: () => true }));

describe("project-scoped Cursor catalog", () => {
  it("does not reuse another project's rows while the next project loads", () => {
    state.catalogs.set("a", {
      configured: true,
      models: [{ modelId: "cursor/a", displayName: "A" }],
    });
    const { result, rerender } = renderHook(
      ({ project }) => useCursorModels(project, true),
      {
        initialProps: { project: "a" },
      },
    );
    expect(result.current.models.some((row) => row.id === "cursor/a")).toBe(
      true,
    );
    rerender({ project: "b" });
    expect(result.current.pending).toBe(true);
    expect(result.current.models.some((row) => row.id === "cursor/a")).toBe(
      false,
    );
    expect(result.current.models.every((row) => row.disabled)).toBe(true);
  });
  it("does not expose an account catalog to non-Cursor consumers", () => {
    const { result } = renderHook(() => useCursorModels("a", false));
    expect(result.current.models).toEqual([]);
    expect(state.queries.at(-1)).toBe("skip");
  });
});
