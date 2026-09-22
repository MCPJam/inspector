/**
 * The viewer's project role, across a members-list RE-load.
 *
 * `useQuery` returning `undefined` does not only mean "first load": the Convex
 * client discards its remote query set on every websocket reconnect, and
 * returning to a tab that was backgrounded long enough to drop the socket does
 * exactly that. Callers gate on `isLoading` by rendering a spinner instead of
 * their subtree, so replaying "not decided yet" unmounts whatever the user was
 * in the middle of (the Swarms create flow's generated personas, in the bug
 * this covers). Once decided, a re-load must not un-decide it.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MemberRow = { email: string; role: string; isPending?: boolean };

const { membersRef } = vi.hoisted(() => ({
  membersRef: { current: undefined as MemberRow[] | undefined },
}));

vi.mock("convex/react", () => ({
  useQuery: (_name: string, args: unknown) =>
    args === "skip" ? undefined : membersRef.current,
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

import { useViewerProjectRole } from "../useProjects";

const VIEWER = "member@test.local";

function render(email: string | null | undefined = VIEWER) {
  return renderHook(
    (props: { viewerEmail: string | null | undefined }) =>
      useViewerProjectRole({
        isAuthenticated: true,
        projectId: "proj-1",
        viewerEmail: props.viewerEmail,
      }),
    { initialProps: { viewerEmail: email } }
  );
}

beforeEach(() => {
  membersRef.current = undefined;
});

describe("useViewerProjectRole", () => {
  it("is pending until the members list first resolves", () => {
    const { result, rerender } = render();
    expect(result.current).toEqual({ role: undefined, isLoading: true });

    membersRef.current = [{ email: VIEWER, role: "member" }];
    rerender({ viewerEmail: VIEWER });

    expect(result.current).toEqual({ role: "member", isLoading: false });
  });

  // Regression (SUTB-2): a reconnect re-resolves the query, and reporting
  // "loading" again is what took the Swarms subtree — and the swarm being
  // authored in it — down.
  it("keeps the decided role while the members list re-loads", () => {
    membersRef.current = [{ email: VIEWER, role: "member" }];
    const { result, rerender } = render();
    expect(result.current).toEqual({ role: "member", isLoading: false });

    membersRef.current = undefined;
    rerender({ viewerEmail: VIEWER });

    expect(result.current).toEqual({ role: "member", isLoading: false });
  });

  it("keeps a decided DENIAL too, rather than flashing a spinner", () => {
    membersRef.current = [{ email: "someone.else@test.local", role: "owner" }];
    const { result, rerender } = render();
    expect(result.current).toEqual({ role: undefined, isLoading: false });

    membersRef.current = undefined;
    rerender({ viewerEmail: VIEWER });

    expect(result.current).toEqual({ role: undefined, isLoading: false });
  });

  it("takes the new answer as soon as the list resolves again", () => {
    membersRef.current = [{ email: VIEWER, role: "admin" }];
    const { result, rerender } = render();
    expect(result.current.role).toBe("admin");

    // Demoted, then removed entirely: the latch spans the gap, never the answer.
    membersRef.current = [{ email: VIEWER, role: "member" }];
    rerender({ viewerEmail: VIEWER });
    expect(result.current).toEqual({ role: "member", isLoading: false });

    membersRef.current = [];
    rerender({ viewerEmail: VIEWER });
    expect(result.current).toEqual({ role: undefined, isLoading: false });
  });

  it("does not carry one viewer's decision over to another", () => {
    membersRef.current = [
      { email: VIEWER, role: "owner" },
      { email: "guest@test.local", role: "guest" },
    ];
    const { result, rerender } = render();
    expect(result.current.role).toBe("owner");

    membersRef.current = undefined;
    rerender({ viewerEmail: "guest@test.local" });

    // A different identity has no decision to fall back on — pending, not owner.
    expect(result.current).toEqual({ role: undefined, isLoading: true });
  });

  it("ignores pending invites when resolving the role", () => {
    membersRef.current = [{ email: VIEWER, role: "admin", isPending: true }];
    const { result } = render();

    expect(result.current).toEqual({ role: undefined, isLoading: false });
  });
});
