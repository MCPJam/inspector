import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  member: undefined as boolean | undefined,
  ready: true,
  query: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    mocks.query(name, args);
    return undefined;
  },
  useAction: () => vi.fn(),
}));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => mocks.member,
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => mocks.ready,
}));

import { useProjectSecrets } from "../useProjectSecrets";

describe("useProjectSecrets actor gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.member = undefined;
    mocks.ready = true;
  });

  it("does not query member-only secrets for a guest or while auth settles", () => {
    const { rerender } = renderHook(() => useProjectSecrets("project-1"));
    expect(mocks.query).toHaveBeenLastCalledWith(
      "projectSecrets:listSecrets",
      "skip",
    );

    mocks.member = false;
    rerender();
    expect(mocks.query).toHaveBeenLastCalledWith(
      "projectSecrets:listSecrets",
      "skip",
    );
  });

  it("queries once Convex confirms a ready member actor", () => {
    mocks.member = true;
    renderHook(() => useProjectSecrets("project-1"));
    expect(mocks.query).toHaveBeenLastCalledWith(
      "projectSecrets:listSecrets",
      { projectId: "project-1" },
    );
  });
});
