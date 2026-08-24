/**
 * The directory hook's contract, and above all its CONNECT ORDERING.
 *
 * The curated flow connects client-first and writes provenance from a later
 * effect keyed on React state, which OAuth's redirect destroys. This flow
 * inverts that: mutation first (validate, dedupe, audit, insert), then
 * localStorage, then `onConnect`. The tests below pin that order rather than
 * just its outcome, because the outcome looks identical right up until a
 * redirect happens.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import {
  DirectoryConnectError,
  describeExistingConnection,
  directorySourceBadge,
  directorySourceLabel,
  describeUnavailable,
  isConnectableDirectoryRow,
  normalizeDirectoryConnectError,
  requiresEndpointChoice,
  resolveConnectedEndpointUrl,
  resolveDirectoryEndpointUrl,
  sourceHasTiers,
  useServerDirectory,
  type DirectoryServer,
} from "../useServerDirectory";

const {
  mockUsePaginatedQuery,
  mockUseQuery,
  mockConnectMutation,
  mockLoadMore,
} = vi.hoisted(() => ({
  mockUsePaginatedQuery: vi.fn(),
  mockUseQuery: vi.fn(),
  mockConnectMutation: vi.fn(),
  mockLoadMore: vi.fn(),
}));

vi.mock("convex/react", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("convex/react");
  return {
    ...actual,
    usePaginatedQuery: (...args: unknown[]) => mockUsePaginatedQuery(...args),
    useQuery: (...args: unknown[]) => mockUseQuery(...args),
    useMutation: () => mockConnectMutation,
  };
});

// The hook imports the gate through the "@/hooks/..." alias, so that is the
// specifier the mock has to name.
vi.mock("@/hooks/useRegistryServers", () => ({
  REGISTRY_FEATURE_ENABLED: true,
}));

function directoryServer(
  overrides: Partial<DirectoryServer> = {}
): DirectoryServer {
  return {
    _id: "cat_1",
    source: "anthropic-directory",
    sourceId: "srv-0001",
    serverName: "com.mcpjam/anthropic-linear-1a2b3c4d",
    displayName: "Linear",
    description: "Track issues.",
    verifiedTier: "partner",
    rowType: "remote",
    endpointKind: "fixed",
    remoteUrl: "https://mcp.linear.app/mcp",
    isAuthless: false,
    curatedOverlap: false,
    ...overrides,
  };
}

function setPage(results: DirectoryServer[], status = "Exhausted") {
  mockUsePaginatedQuery.mockReturnValue({
    results,
    status,
    loadMore: mockLoadMore,
  });
}

function renderDirectory(
  props: Partial<Parameters<typeof useServerDirectory>[0]> = {}
) {
  const onConnect = vi.fn();
  const view = renderHook(() =>
    useServerDirectory({
      projectId: "proj_1",
      isAuthenticated: true,
      onConnect,
      ...props,
    })
  );
  return { ...view, onConnect };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  setPage([]);
  mockUseQuery.mockReturnValue([]);
  mockConnectMutation.mockResolvedValue({
    serverId: "srv_1",
    serverName: "Linear",
  });
});

describe("useServerDirectory — the feature gate", () => {
  it("skips BOTH queries when the caller disables it", () => {
    renderDirectory({ enabled: false });
    expect(mockUsePaginatedQuery).toHaveBeenCalledWith(
      "serverCatalogQueries:searchCatalogServers",
      "skip",
      expect.objectContaining({ initialNumItems: 24 })
    );
    expect(mockUseQuery).toHaveBeenCalledWith(
      "serverCatalogQueries:getProjectCatalogConnections",
      "skip"
    );
  });

  it("refuses to connect while the feature is dark", async () => {
    const server = directoryServer();
    setPage([server]);
    const { result, onConnect } = renderDirectory({ enabled: false });

    await act(async () => {
      await expect(result.current.connect(server)).rejects.toBeInstanceOf(
        DirectoryConnectError
      );
    });
    expect(mockConnectMutation).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("returns no items even if a page somehow arrived", () => {
    setPage([directoryServer()]);
    const { result } = renderDirectory({ enabled: false });
    expect(result.current.items).toEqual([]);
  });
});

describe("useServerDirectory — query arguments", () => {
  it("omits `q` entirely while the box is empty", () => {
    renderDirectory();
    expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
      "serverCatalogQueries:searchCatalogServers",
      { source: "anthropic-directory" },
      expect.anything()
    );
  });

  it("debounces a typed query, then sends it trimmed", async () => {
    const { result } = renderDirectory();
    act(() => result.current.setQuery("  linear  "));
    // Not sent yet — one query per word, not per keystroke.
    expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
      "serverCatalogQueries:searchCatalogServers",
      { source: "anthropic-directory" },
      expect.anything()
    );

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => {
      expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
        "serverCatalogQueries:searchCatalogServers",
        { source: "anthropic-directory", q: "linear" },
        expect.anything()
      );
    });
  });

  it('clearing the box goes back to OMITTING `q`, never sending ""', async () => {
    // Blank and omitted mean the same thing to the backend, but sending "" is
    // a different query key — every clear would refetch page 1 of a listing
    // already in hand.
    const { result } = renderDirectory();
    act(() => result.current.setQuery("linear"));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    act(() => result.current.setQuery("   "));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
        "serverCatalogQueries:searchCatalogServers",
        { source: "anthropic-directory" },
        expect.anything()
      );
    });
  });

  it("sends verifiedTier only for a real tier, never for `all`", async () => {
    const { result } = renderDirectory();
    act(() => result.current.setTier("partner"));
    await waitFor(() => {
      expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
        "serverCatalogQueries:searchCatalogServers",
        { source: "anthropic-directory", verifiedTier: "partner" },
        expect.anything()
      );
    });

    act(() => result.current.setTier("all"));
    await waitFor(() => {
      expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
        "serverCatalogQueries:searchCatalogServers",
        { source: "anthropic-directory" },
        expect.anything()
      );
    });
  });

  it("skips the connections query without a project or a session", () => {
    renderDirectory({ projectId: null });
    expect(mockUseQuery).toHaveBeenCalledWith(
      "serverCatalogQueries:getProjectCatalogConnections",
      "skip"
    );

    vi.clearAllMocks();
    setPage([]);
    renderDirectory({ isAuthenticated: false });
    expect(mockUseQuery).toHaveBeenCalledWith(
      "serverCatalogQueries:getProjectCatalogConnections",
      "skip"
    );
  });
});

describe("useServerDirectory — curated overlap", () => {
  it("keeps rows a retired curated card used to cover", () => {
    setPage([
      directoryServer({ _id: "a", displayName: "Keep" }),
      directoryServer({
        _id: "b",
        displayName: "Shadowed",
        curatedOverlap: true,
      }),
    ]);
    const { result } = renderDirectory();
    expect(result.current.items.map((i) => i.displayName)).toEqual([
      "Keep",
      "Shadowed",
    ]);
  });
});

describe("useServerDirectory — connect ordering", () => {
  it("calls the mutation BEFORE onConnect, and passes back its name", async () => {
    const order: string[] = [];
    mockConnectMutation.mockImplementation(async () => {
      order.push("mutation");
      return { serverId: "srv_1", serverName: "Linear" };
    });
    const server = directoryServer();
    setPage([server]);
    const { result, onConnect } = renderDirectory();
    onConnect.mockImplementation(() => order.push("onConnect"));

    await act(async () => {
      await result.current.connect(server);
    });

    expect(order).toEqual(["mutation", "onConnect"]);
    expect(mockConnectMutation).toHaveBeenCalledWith({
      catalogServerId: "cat_1",
      projectId: "proj_1",
    });
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        // The NAME the mutation created the row under, so the client connect
        // resolves the same `(projectId, name)` row instead of a duplicate.
        name: "Linear",
        type: "http",
        url: "https://mcp.linear.app/mcp",
      })
    );
  });

  it("connects through auto-discovery, not the row's `is_authless`", async () => {
    const server = directoryServer({ isAuthless: true });
    setPage([server]);
    const { result, onConnect } = renderDirectory();

    await act(async () => {
      await result.current.connect(server);
    });

    const [formData] = onConnect.mock.calls[0];
    // Stale upstream metadata must not decide the auth method; "auto" probes.
    expect(formData.authMethod).toBe("auto");
    // The compat mirror that gates entry into the discover-and-escalate
    // branch — without it a server needing auth reports a raw transport error.
    expect(formData.useOAuth).toBe(true);
  });

  it("writes the pending marker BEFORE onConnect can redirect", async () => {
    let pendingAtOnConnect: string | null = null;
    const server = directoryServer();
    setPage([server]);
    const { result, onConnect } = renderDirectory();
    onConnect.mockImplementation(() => {
      pendingAtOnConnect = localStorage.getItem("mcp-quick-connect-pending");
    });

    await act(async () => {
      await result.current.connect(server);
    });

    expect(pendingAtOnConnect).not.toBeNull();
    const parsed = JSON.parse(pendingAtOnConnect!);
    expect(parsed).toMatchObject({
      serverName: "Linear",
      displayName: "Linear",
      sourceTab: "registry",
      catalogServerId: "cat_1",
    });
  });

  it("never calls onConnect when the mutation refuses", async () => {
    mockConnectMutation.mockRejectedValue(
      new ConvexError({
        code: "endpoint_url_required",
        message: "Choose one.",
        options: ["https://a.example/mcp"],
      })
    );
    const server = directoryServer({ endpointKind: "options" });
    setPage([server]);
    const { result, onConnect } = renderDirectory();

    await act(async () => {
      await expect(result.current.connect(server)).rejects.toBeInstanceOf(
        DirectoryConnectError
      );
    });

    expect(onConnect).not.toHaveBeenCalled();
    // And nothing was written that a later effect could act on.
    expect(localStorage.getItem("mcp-quick-connect-pending")).toBeNull();
  });

  it("forwards a chosen endpoint and uses it as the connect URL", async () => {
    const server = directoryServer({
      endpointKind: "options",
      remoteUrl: undefined,
      remoteUrlOptions: [
        "https://mcp.braze.com/mcp",
        "https://mcp.braze.eu/mcp",
      ],
    });
    setPage([server]);
    const { result, onConnect } = renderDirectory();

    await act(async () => {
      await result.current.connect(server, "https://mcp.braze.eu/mcp");
    });

    expect(mockConnectMutation).toHaveBeenCalledWith({
      catalogServerId: "cat_1",
      projectId: "proj_1",
      endpointUrl: "https://mcp.braze.eu/mcp",
    });
    expect(onConnect.mock.calls[0][0].url).toBe("https://mcp.braze.eu/mcp");
  });

  it("refuses without a project rather than calling the mutation", async () => {
    const server = directoryServer();
    setPage([server]);
    const { result, onConnect } = renderDirectory({ projectId: null });

    await act(async () => {
      await expect(result.current.connect(server)).rejects.toMatchObject({
        code: "project_required",
      });
    });
    expect(mockConnectMutation).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
  });
});

describe("normalizeDirectoryConnectError", () => {
  it("maps every typed code the mutation can throw", () => {
    const codes = [
      "catalog_server_not_found",
      "catalog_server_removed",
      "catalog_server_not_connectable",
      "endpoint_url_required",
      "endpoint_url_not_configurable",
      "endpoint_url_not_allowed",
      "endpoint_url_invalid",
      "endpoint_pattern_unusable",
      "catalog_server_missing_endpoint",
      "already_connected_to_different_endpoint",
      "server_name_conflict",
    ];
    for (const code of codes) {
      const normalized = normalizeDirectoryConnectError(
        new ConvexError({ code, message: `msg for ${code}` })
      );
      expect(normalized.code).toBe(code);
      expect(normalized.message).toBe(`msg for ${code}`);
    }
  });

  it("carries the payload each code needs to be actionable", () => {
    const options = normalizeDirectoryConnectError(
      new ConvexError({
        code: "endpoint_url_required",
        message: "Pick one.",
        options: ["https://a.example/mcp", "https://b.example/mcp"],
      })
    );
    expect(options.options).toEqual([
      "https://a.example/mcp",
      "https://b.example/mcp",
    ]);

    const tenant = normalizeDirectoryConnectError(
      new ConvexError({
        code: "endpoint_url_required",
        message: "Your URL.",
        pattern: "^https://mcp\\.acme\\.(com|eu)$",
      })
    );
    expect(tenant.pattern).toBe("^https://mcp\\.acme\\.(com|eu)$");

    const conflict = normalizeDirectoryConnectError(
      new ConvexError({
        code: "already_connected_to_different_endpoint",
        message: "Elsewhere.",
        connectedUrl: "https://mcp.braze.eu/mcp",
      })
    );
    expect(conflict.connectedUrl).toBe("https://mcp.braze.eu/mcp");
  });

  it("reads a JSON-serialized ConvexError payload too", () => {
    const error = new ConvexError(
      JSON.stringify({ code: "catalog_server_removed", message: "Gone." })
    );
    expect(normalizeDirectoryConnectError(error).code).toBe(
      "catalog_server_removed"
    );
  });

  it("falls back to `unknown` rather than guessing from message text", () => {
    // A masked throw looks exactly like a network blip; inventing a code from
    // its wording is how an error mapping breaks when someone rephrases it.
    const plain = normalizeDirectoryConnectError(
      new Error("endpoint_url_required")
    );
    expect(plain.code).toBe("unknown");

    const untagged = normalizeDirectoryConnectError(
      new ConvexError({ code: "something_new", message: "?" })
    );
    expect(untagged.code).toBe("unknown");
  });

  it("passes an already-normalized error straight through", () => {
    const original = new DirectoryConnectError("endpoint_url_invalid", "Bad.");
    expect(normalizeDirectoryConnectError(original)).toBe(original);
  });
});

describe("endpoint helpers", () => {
  it("only options and tenant rows require a choice", () => {
    expect(requiresEndpointChoice({ endpointKind: "fixed" })).toBe(false);
    expect(requiresEndpointChoice({ endpointKind: "none" })).toBe(false);
    expect(requiresEndpointChoice({ endpointKind: "options" })).toBe(true);
    expect(requiresEndpointChoice({ endpointKind: "tenant" })).toBe(true);
  });

  it("a fixed row ignores a supplied URL — the catalog's is the only one", () => {
    expect(
      resolveDirectoryEndpointUrl(
        { endpointKind: "fixed", remoteUrl: "https://fixed.example/mcp" },
        "https://elsewhere.example/mcp"
      )
    ).toBe("https://fixed.example/mcp");
  });

  it("a tenant row uses exactly what the user supplied", () => {
    expect(
      resolveDirectoryEndpointUrl(
        { endpointKind: "tenant", remoteUrl: undefined },
        "https://mine.example/mcp"
      )
    ).toBe("https://mine.example/mcp");
  });
});

describe("useServerDirectory — pending marker rollback", () => {
  it("rolls the marker back when onConnect itself throws", async () => {
    // The marker only makes sense beside a connect that actually started, and
    // the caller cannot tell a mutation refusal from an onConnect throw — so
    // the undo lives beside the write.
    const server = directoryServer();
    setPage([server]);
    const { result, onConnect } = renderDirectory();
    onConnect.mockImplementation(() => {
      throw new Error("connect blew up");
    });

    await act(async () => {
      await expect(result.current.connect(server)).rejects.toBeInstanceOf(
        DirectoryConnectError
      );
    });

    expect(localStorage.getItem("mcp-quick-connect-pending")).toBeNull();
  });

  it("hands the marker back so the caller can mirror it into state", async () => {
    const server = directoryServer();
    setPage([server]);
    const { result } = renderDirectory();

    let outcome!: Awaited<ReturnType<typeof result.current.connect>>;
    await act(async () => {
      outcome = await result.current.connect(server);
    });

    expect(outcome.pending).toMatchObject({
      serverName: "Linear",
      sourceTab: "registry",
      catalogServerId: "cat_1",
    });
  });
});

describe("useServerDirectory — the source facet", () => {
  it("opens on the Claude directory, the daily and reliable one", () => {
    const { result } = renderDirectory();
    expect(result.current.source).toBe("anthropic-directory");
    expect(result.current.hasTiers).toBe(true);
  });

  it("switching source re-scopes the query", async () => {
    const { result } = renderDirectory();
    act(() => result.current.setSource("chatgpt-directory"));
    await waitFor(() => {
      expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
        "serverCatalogQueries:searchCatalogServers",
        { source: "chatgpt-directory" },
        expect.anything()
      );
    });
  });

  it("switching to a source without tiers CLEARS the tier", async () => {
    // A tier that survived the switch would silently narrow a catalog that
    // publishes no tiers at all — i.e. empty it, with a filter the UI is no
    // longer even showing.
    const { result } = renderDirectory();
    act(() => result.current.setTier("partner"));
    act(() => result.current.setSource("chatgpt-directory"));

    expect(result.current.tier).toBe("all");
    expect(result.current.hasTiers).toBe(false);
    await waitFor(() => {
      expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
        "serverCatalogQueries:searchCatalogServers",
        { source: "chatgpt-directory" },
        expect.anything()
      );
    });
  });

  it("never sends a tier the current source does not publish", async () => {
    const { result } = renderDirectory();
    act(() => result.current.setSource("chatgpt-directory"));
    act(() => result.current.setTier("partner"));
    await waitFor(() => {
      expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
        "serverCatalogQueries:searchCatalogServers",
        { source: "chatgpt-directory" },
        expect.anything()
      );
    });
  });

  it("reports how fresh the SELECTED source is", () => {
    mockUseQuery.mockImplementation((name: string) =>
      name === "serverCatalogQueries:getCatalogSourceStatus"
        ? [
            {
              source: "anthropic-directory",
              lastSyncedAt: 1_000,
              liveCount: 2000,
              upstreamFetchedAt: null,
            },
            {
              source: "chatgpt-directory",
              lastSyncedAt: 9_000,
              liveCount: 2900,
              upstreamFetchedAt: 8_000,
            },
          ]
        : []
    );

    const { result } = renderDirectory();
    expect(result.current.lastSyncedAt).toBe(1_000);

    act(() => result.current.setSource("chatgpt-directory"));
    // The SCRAPE time, not the ingest time: uploading a Tuesday sweep on
    // Friday makes the catalog Tuesday-fresh, and saying "Friday" would
    // overstate it by three days.
    expect(result.current.lastSyncedAt).toBe(8_000);
  });

  it("connectable-only asks the backend, and does NOT narrow to `fixed`", async () => {
    // The bug this guards: `endpointKind: 'fixed'` looks like "connectable"
    // and is not. `options` (pick a region) and `tenant` (supply your own
    // instance URL) rows connect fine — they just ask a question first — so
    // filtering to `fixed` would hide every regional and BYO-instance
    // connector behind a toggle that claims to hide only the unusable ones.
    const { result } = renderDirectory();
    act(() => result.current.setConnectableOnly(true));
    await waitFor(() => {
      expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
        "serverCatalogQueries:searchCatalogServers",
        { source: "anthropic-directory", connectableOnly: true },
        expect.anything()
      );
    });

    const [, args] = mockUsePaginatedQuery.mock.calls.at(-1) as [
      string,
      Record<string, unknown>
    ];
    expect(args.endpointKind).toBeUndefined();
  });

  it("keeps every connectable kind visible while the toggle is on", () => {
    // The hook does not drop rows itself — the query does — so an `options`
    // or `tenant` row that comes back stays on screen and stays connectable.
    const rows = [
      directoryServer({ _id: "a", endpointKind: "fixed" }),
      directoryServer({
        _id: "b",
        endpointKind: "options",
        remoteUrl: undefined,
        remoteUrlOptions: ["https://mcp.braze.com/mcp"],
      }),
      directoryServer({
        _id: "c",
        endpointKind: "tenant",
        remoteUrl: undefined,
        remoteUrlRegex: "https://.*\\.acme\\.com/mcp",
      }),
    ];
    setPage(rows);
    const { result } = renderDirectory();
    act(() => result.current.setConnectableOnly(true));

    expect(result.current.items.map((item) => item._id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(rows.every(isConnectableDirectoryRow)).toBe(true);
  });

  it("stops asking for the filter when the toggle goes off", async () => {
    const { result } = renderDirectory();
    act(() => result.current.setConnectableOnly(true));
    act(() => result.current.setConnectableOnly(false));
    await waitFor(() => {
      expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
        "serverCatalogQueries:searchCatalogServers",
        { source: "anthropic-directory" },
        expect.anything()
      );
    });
  });

  it("shows the whole census by default", () => {
    const { result } = renderDirectory();
    expect(result.current.connectableOnly).toBe(false);
  });

  it("sourceHasTiers is what the UI hides the filter on", () => {
    expect(sourceHasTiers("anthropic-directory")).toBe(true);
    expect(sourceHasTiers("chatgpt-directory")).toBe(false);
  });
});

describe("connectability copy", () => {
  const row = (overrides: Partial<DirectoryServer>) =>
    directoryServer({ endpointKind: "none", ...overrides });

  it("a hidden hosted endpoint is not called a desktop extension", () => {
    const text = describeUnavailable(
      row({ rowType: "remote", unavailableReason: "endpoint_hidden" })
    );
    expect(text).not.toMatch(/desktop extension/i);
    expect(text).toMatch(/not published/i);
  });

  it("an unverified endpoint says what was actually tried", () => {
    expect(
      describeUnavailable(
        row({ rowType: "remote", unavailableReason: "endpoint_unverified" })
      )
    ).toMatch(/unverified/i);
  });

  it("a genuine local extension still says so", () => {
    expect(describeUnavailable(row({ rowType: "local" }))).toMatch(
      /local desktop extension/i
    );
  });

  it("only `none` rows are unconnectable", () => {
    expect(isConnectableDirectoryRow(directoryServer())).toBe(true);
    expect(isConnectableDirectoryRow(row({ rowType: "remote" }))).toBe(false);
  });
});

describe("cross-source connect", () => {
  it("names the directory a reused connection came from", () => {
    expect(
      describeExistingConnection({
        serverId: "srv_1",
        serverName: "Linear",
        outcome: "existing_endpoint",
        existing: {
          catalogServerId: "cat_9",
          source: "anthropic-directory",
          displayName: "Linear",
        },
      })
    ).toBe("Already connected via the Claude directory.");
  });

  it("degrades to a generic phrase rather than naming a source we do not know", () => {
    expect(
      describeExistingConnection({
        serverId: "srv_1",
        serverName: "Linear",
        outcome: "existing_endpoint",
        existing: {
          catalogServerId: "cat_9",
          source: "some-future-directory",
          displayName: "Linear",
        },
      })
    ).toBe("Already connected via another catalog.");
  });

  it("an inherited property name is NOT a known source", () => {
    // `in` would say `toString` is a source and render the function itself
    // into the sentence. `Object.hasOwn` is what keeps the fallback reachable.
    expect(
      describeExistingConnection({
        serverId: "srv_1",
        serverName: "Linear",
        outcome: "existing_endpoint",
        existing: {
          catalogServerId: "cat_9",
          source: "toString",
          displayName: "Linear",
        },
      })
    ).toBe("Already connected via another catalog.");
    expect(directorySourceLabel("toString")).toBe("another catalog");
    expect(directorySourceBadge("constructor")).toBe(
      "From an upstream directory"
    );
  });

  it("says nothing at all for an ordinary install", () => {
    expect(
      describeExistingConnection({
        serverId: "srv_1",
        serverName: "Linear",
        outcome: "created",
      })
    ).toBeNull();
  });

  it("passes the backend outcome through to the caller", async () => {
    mockConnectMutation.mockResolvedValue({
      serverId: "srv_1",
      serverName: "Linear",
      outcome: "existing_endpoint",
      // Every `existing_endpoint` result carries the URL that connection
      // holds; a result without one is refused, which the two cases below pin.
      endpointUrl: "https://mcp.linear.app/mcp",
      existing: {
        catalogServerId: "cat_9",
        source: "anthropic-directory",
        displayName: "Linear",
      },
    });
    const server = directoryServer({ source: "chatgpt-directory" });
    setPage([server]);
    const { result } = renderDirectory();

    let outcome: string | undefined;
    await act(async () => {
      outcome = (await result.current.connect(server)).outcome;
    });
    expect(outcome).toBe("existing_endpoint");
  });

  it("connects the URL ALREADY held, not this card's spelling of it", async () => {
    // The backend matched by CANONICAL url, so the two rows can differ by a
    // trailing slash or host casing and still be the same endpoint. Connecting
    // with this card's spelling would rewrite the stored endpoint of a server
    // this click did not create — and the OAuth resource indicator bound to
    // that URL with it.
    mockConnectMutation.mockResolvedValue({
      serverId: "srv_1",
      serverName: "Linear",
      outcome: "existing_endpoint",
      endpointUrl: "https://mcp.linear.app/mcp",
      existing: {
        catalogServerId: "cat_9",
        source: "anthropic-directory",
        displayName: "Linear",
      },
    });
    const server = directoryServer({
      source: "chatgpt-directory",
      remoteUrl: "https://MCP.linear.app/mcp/",
    });
    setPage([server]);
    const { result, onConnect } = renderDirectory();

    await act(async () => {
      await result.current.connect(server);
    });

    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://mcp.linear.app/mcp" })
    );
  });

  it("an ordinary install still uses the row's own URL", async () => {
    mockConnectMutation.mockResolvedValue({
      serverId: "srv_1",
      serverName: "Acme",
      outcome: "created",
    });
    const server = directoryServer({
      remoteUrl: "https://mcp.acme.example/mcp",
    });
    setPage([server]);
    const { result, onConnect } = renderDirectory();

    await act(async () => {
      await result.current.connect(server);
    });

    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://mcp.acme.example/mcp" })
    );
  });

  // The two halves deploy separately, so an inspector carrying this code can
  // talk to a backend that predates `endpointUrl`. Falling back to the card's
  // URL there is the precise bug the field exists to prevent, and it would be
  // silent — so the click has to fail instead.
  // `null` is in the table beside the other two because the mutation result is
  // CAST to `DirectoryConnectResult`, not validated — the type says what the
  // current backend returns, not what an older one across the wire actually
  // sends. `!result.endpointUrl` already covers it; this pins that it does.
  it.each([
    ["omits it", {}],
    ["sends it empty", { endpointUrl: "" }],
    ["sends it null", { endpointUrl: null }],
  ])(
    "refuses to connect when an existing_endpoint result %s",
    async (_label, extra) => {
      mockConnectMutation.mockResolvedValue({
        serverId: "srv_1",
        serverName: "Linear",
        outcome: "existing_endpoint",
        ...extra,
        existing: {
          catalogServerId: "cat_9",
          source: "anthropic-directory",
          displayName: "Linear",
        },
      });
      const server = directoryServer({
        source: "chatgpt-directory",
        remoteUrl: "https://MCP.linear.app/mcp/",
      });
      setPage([server]);
      const { result, onConnect } = renderDirectory();

      await act(async () => {
        await expect(result.current.connect(server)).rejects.toMatchObject({
          code: "existing_connection_missing_endpoint",
        });
      });
      // The card's spelling never reaches the connect path.
      expect(onConnect).not.toHaveBeenCalled();
    }
  );

  it("resolves the card's URL for outcomes that are about THIS card", () => {
    // The refusal is scoped to `existing_endpoint`. A created/reconnected
    // result is this card's own server, so its own URL is the right one and
    // a missing `endpointUrl` is not a contract violation there.
    const server = {
      endpointKind: "fixed" as const,
      remoteUrl: "https://a/mcp",
    };
    for (const outcome of ["created", "reconnected"] as const) {
      expect(resolveConnectedEndpointUrl(server, { outcome })).toBe(
        "https://a/mcp"
      );
    }
  });
});
