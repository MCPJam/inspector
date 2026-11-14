import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";

const useQueries = vi.fn(
  (_queries: Record<string, unknown>): Record<string, unknown> => ({}),
);
const session = vi.hoisted(() => ({ signedIn: true, userReady: true }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: session.signedIn }),
  useQueries: (queries: Record<string, unknown>) => useQueries(queries),
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => session.userReady,
}));

import { useOrgHarnessKeys } from "../use-org-harness-keys";

const strict = { aiKeyPolicy: { requireOrgKeys: true, revision: 1 } };
const hosts = [{ harness: "cursor" }, { harness: "claude-code" }, {}];

describe("useOrgHarnessKeys", () => {
  beforeEach(() => {
    useQueries.mockReset();
    useQueries.mockImplementation(() => ({}));
    session.signedIn = true;
    session.userReady = true;
  });
  afterEach(() => vi.restoreAllMocks());

  it("asks for the Cursor key's readiness while the organization requires its own keys", () => {
    renderHook(() => useOrgHarnessKeys("project-1", strict, hosts));
    const queries = useQueries.mock.lastCall?.[0] as Record<
      string,
      { query: FunctionReference<"query">; args: unknown }
    >;
    expect(Object.keys(queries)).toEqual(["cursor"]);
    expect(getFunctionName(queries.cursor.query)).toBe(
      "organizationHarnessCredentials:getReadinessForProject",
    );
    expect(queries.cursor.args).toEqual({
      projectId: "project-1",
      harnessId: "cursor",
    });
  });

  it("asks nothing with the policy off, before sign-in, or with no Cursor client", () => {
    renderHook(() =>
      useOrgHarnessKeys(
        "project-1",
        { aiKeyPolicy: { requireOrgKeys: false, revision: 2 } },
        hosts,
      ),
    );
    expect(useQueries).toHaveBeenLastCalledWith({});
    renderHook(() => useOrgHarnessKeys("project-1", undefined, hosts));
    expect(useQueries).toHaveBeenLastCalledWith({});
    renderHook(() =>
      useOrgHarnessKeys("project-1", strict, [{ harness: "codex" }]),
    );
    expect(useQueries).toHaveBeenLastCalledWith({});
    session.userReady = false;
    renderHook(() => useOrgHarnessKeys("project-1", strict, hosts));
    expect(useQueries).toHaveBeenLastCalledWith({});
  });

  it("hands Convex the same queries object while its inputs are unchanged", () => {
    const { rerender } = renderHook(
      ({ clients }) => useOrgHarnessKeys("project-1", strict, clients),
      { initialProps: { clients: hosts } },
    );
    rerender({ clients: [...hosts] });
    expect(useQueries.mock.calls[1][0]).toBe(useQueries.mock.calls[0][0]);
  });

  it.each(["ready", "missing", "invalid"])("reads a %s answer", (readiness) => {
    useQueries.mockImplementation(() => ({ cursor: { readiness } }));
    const { result } = renderHook(() =>
      useOrgHarnessKeys("project-1", strict, hosts),
    );
    expect(result.current).toEqual({ cursor: readiness });
  });

  it("leaves the launch to decide while loading, outside the project, or on an error", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const answer of [
      undefined,
      null,
      { readiness: "unknown" },
      new Error("Could not find public function"),
    ]) {
      useQueries.mockImplementation(() => ({ cursor: answer }));
      const { result } = renderHook(() =>
        useOrgHarnessKeys("project-1", strict, hosts),
      );
      expect(result.current).toEqual({});
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
