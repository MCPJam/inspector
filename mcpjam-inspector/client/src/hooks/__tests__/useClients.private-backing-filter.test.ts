/**
 * `useHostList` hides private scenario-backing clients BY DEFAULT.
 *
 * The default is the whole mechanism. An earlier version of this change
 * filtered at the five call sites that looked like pickers, which did nothing:
 * `HostPicker`, `MultiHostPicker` and `ClientAttachmentsEditor` each call this
 * hook themselves, so the visible dropdowns still offered backing clients while
 * the surrounding code believed they were hidden. Filtering at the source is
 * what makes the rule reach every picker, including ones not written yet — so
 * the default, and the deliberate opt-out for id→row lookups, are locked here.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHostList } from "../useClients";
import { bundledHostCompatCatalog } from "@mcpjam/sdk/host-compat";

const { mockUseMutation, mockUseQuery, mockDbUserReady, mockCatalogState } = vi.hoisted(() => ({
  mockUseMutation: vi.fn(),
  mockUseQuery: vi.fn(),
  mockDbUserReady: { value: true },
  mockCatalogState: {
    value: {
      status: "loading",
      catalog: null,
      version: null,
      source: null,
    } as any,
  },
}));

vi.mock("convex/react", () => ({
  useMutation: mockUseMutation,
  useQuery: mockUseQuery,
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => mockDbUserReady.value,
}));

vi.mock("@/lib/host-compat/use-host-catalog", () => ({
  useHostCatalog: () => mockCatalogState.value,
}));

const PROJECT_ID = "m17b6q9xw2tv4kz8p3r5s0dc";

const HOSTS = [
  { hostId: "plain", name: "Plain", ownerScope: null },
  { hostId: "backing", name: "Backing", ownerScope: { type: "user_testing" } },
  { hostId: "swarm", name: "Swarm", ownerScope: { type: "journeys" } },
] as any[];

beforeEach(() => {
  vi.clearAllMocks();
  mockDbUserReady.value = true;
  mockCatalogState.value = {
    status: "loading",
    catalog: null,
    version: null,
    source: null,
  };
});

describe("useHostList private-backing filter", () => {
  it("drops user_testing clients by default", () => {
    mockUseQuery.mockReturnValue(HOSTS);

    const { result } = renderHook(() =>
      useHostList({ isAuthenticated: true, projectId: PROJECT_ID }),
    );

    expect(result.current.hosts.map((h) => h.hostId)).toEqual([
      "plain",
      "swarm",
    ]);
  });

  it("keeps journeys clients — they are real clients, hidden by a different rule", () => {
    mockUseQuery.mockReturnValue(HOSTS);

    const { result } = renderHook(() =>
      useHostList({ isAuthenticated: true, projectId: PROJECT_ID }),
    );

    expect(result.current.hosts.map((h) => h.hostId)).toContain("swarm");
  });

  it("returns every client when a lookup opts in", () => {
    mockUseQuery.mockReturnValue(HOSTS);

    const { result } = renderHook(() =>
      useHostList({
        isAuthenticated: true,
        projectId: PROJECT_ID,
        includePrivateBacking: true,
      }),
    );

    expect(result.current.hosts.map((h) => h.hostId)).toEqual([
      "plain",
      "backing",
      "swarm",
    ]);
  });

  it("adds display names without letting hidden clients consume suffixes", () => {
    mockUseQuery.mockReturnValue([
      {
        hostId: "hidden-acme",
        name: "Acme",
        createdAt: 1,
        ownerScope: { type: "user_testing" },
      },
      { hostId: "visible-acme", name: "Acme", createdAt: 2 },
      { hostId: "saved-cursor", name: "Cursor", createdAt: 3 },
    ]);

    const { result } = renderHook(() =>
      useHostList({ isAuthenticated: true, projectId: PROJECT_ID }),
    );

    expect(
      result.current.hosts.map(({ hostId, displayName }) => ({
        hostId,
        displayName,
      })),
    ).toEqual([
      { hostId: "visible-acme", displayName: "Acme" },
      { hostId: "saved-cursor", displayName: "Cursor #2" },
    ]);
  });

  it("reserves labels added by the live catalog", () => {
    const bundled = bundledHostCompatCatalog();
    const template = Object.values(bundled.hostsById)[0];
    mockCatalogState.value = {
      status: "live",
      catalog: {
        hostsById: {
          ...bundled.hostsById,
          future: { ...template, id: "future", label: "Future Client" },
        },
      },
      version: 2,
      source: "backend",
    } as any;
    mockUseQuery.mockReturnValue([
      { hostId: "saved-future", name: "Future Client", createdAt: 1 },
    ]);

    const { result } = renderHook(() =>
      useHostList({ isAuthenticated: true, projectId: PROJECT_ID }),
    );

    expect(result.current.hosts[0]?.displayName).toBe("Future Client #2");
  });

  it("reports loading (not an empty list) while the query is in flight", () => {
    mockUseQuery.mockReturnValue(undefined);

    const { result } = renderHook(() =>
      useHostList({ isAuthenticated: true, projectId: PROJECT_ID }),
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.hosts).toEqual([]);
  });

  it("reports loading while authenticated but waiting for the user row", () => {
    mockDbUserReady.value = false;
    mockUseQuery.mockReturnValue(undefined);

    const { result } = renderHook(() =>
      useHostList({ isAuthenticated: true, projectId: PROJECT_ID }),
    );

    expect(mockUseQuery).toHaveBeenCalledWith("hosts:listHosts", "skip");
    expect(result.current.isLoading).toBe(true);
    expect(result.current.hosts).toEqual([]);
  });

  // `HostsRoute` reads a settled empty list as "this permalink is dead" and
  // bounces it with a toast, and the `?template=` flow reads it as "no such
  // host yet" and mints a duplicate. Neither window has an answer yet, so both
  // must report loading rather than an answered empty.
  it.each([
    ["signed out", { isAuthenticated: false, projectId: PROJECT_ID }],
    [
      "a placeholder project id",
      { isAuthenticated: true, projectId: "project_pending" },
    ],
  ])("reports loading while the query is skipped for %s", (_label, args) => {
    mockUseQuery.mockReturnValue(undefined);

    const { result } = renderHook(() => useHostList(args));

    expect(mockUseQuery).toHaveBeenCalledWith("hosts:listHosts", "skip");
    expect(result.current.isLoading).toBe(true);
    expect(result.current.hosts).toEqual([]);
  });

  it("queries with a trimmed project id", () => {
    mockUseQuery.mockReturnValue(HOSTS);

    renderHook(() =>
      useHostList({ isAuthenticated: true, projectId: ` ${PROJECT_ID} ` }),
    );

    expect(mockUseQuery).toHaveBeenCalledWith("hosts:listHosts", {
      projectId: PROJECT_ID,
    });
  });

  it("handles a null result from a skipped query", () => {
    mockUseQuery.mockReturnValue(null);

    const { result } = renderHook(() =>
      useHostList({ isAuthenticated: false, projectId: PROJECT_ID }),
    );

    expect(result.current.hosts).toEqual([]);
  });
});
