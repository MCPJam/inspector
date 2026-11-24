import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";

const { useQueriesMock, useQueryMock, reportBoundaryError } = vi.hoisted(() => ({
  useQueriesMock: vi.fn(),
  useQueryMock: vi.fn(),
  reportBoundaryError: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQueries: (...args: unknown[]) => useQueriesMock(...args),
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@/lib/error-reporting", () => ({
  reportBoundaryError,
  reportCaught: vi.fn(),
}));

import {
  SERVER_URL_CHANGES_QUERY,
  ServerCredentialRecovery,
  isServerUrlHistoryUnavailable,
} from "../ServerUrlChangeHistory";
import { ServerHistoryContent } from "../ServerHistoryContent";
import { createServer } from "@/test/factories";

// The exact string `convex/react` throws from render in PRODUCTION: the
// server redacts "Could not find public function" to "Server Error", so the
// function name in the prefix is all the client gets. Copied from the PostHog
// issue that motivated the boundary.
const PROD_DARK_SHIP = new Error(
  `[CONVEX Q(${SERVER_URL_CHANGES_QUERY})] [Request ID: 5eb87f6c9d3ef8d5] Server Error\n  Called by client`
);
const DEV_DARK_SHIP = new Error(
  `[CONVEX Q(${SERVER_URL_CHANGES_QUERY})] [Request ID: abc] Could not find public function for '${SERVER_URL_CHANGES_QUERY}'`
);

// `auditEvents:listServerUrlChanges` projects the row: `id`, not Convex's
// `_id`, and a decided metadata list.
const urlChange = {
  id: "evt_1",
  action: "server.url.changed",
  actorEmail: "editor@example.com",
  timestamp: new Date(2026, 8, 9, 12).getTime(),
  metadata: {
    cause: "url_origin_change",
    previousOrigin: "https://old.example.com",
    nextOrigin: "https://new.example.com",
    clearedOnOriginChange: true,
    viaTransportFlip: false,
    clearedKinds: ["headers", "legacy_headers", "bearer_token"],
  },
};

// A url repoint writes the clear alongside the url event.
const urlChangeClear = {
  id: "evt_1_clear",
  action: "server.credentials.cleared_on_origin_change",
  actorEmail: "editor@example.com",
  timestamp: Date.UTC(2026, 8, 9, 12, 0, 0),
  metadata: {
    cause: "url_origin_change",
    previousOrigin: "https://old.example.com",
    nextOrigin: "https://new.example.com",
    clearedKinds: ["headers"],
  },
};

const history = <ServerHistoryContent projectId="proj_1" serverId="srv_1" />;
const recoveryServer = createServer({
  config: { url: "https://new.example.com/mcp" },
  connectionStatus: "failed",
  lastError: "HTTP 401 Unauthorized",
});
const recoveryAuth = { method: "bearer", bearer: null, headers: null } as const;

describe("Server History", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue([]);
    useQueriesMock.mockReset();
    useQueriesMock.mockReturnValue({ result: [] });
    reportBoundaryError.mockReset();
    // React logs caught boundary errors; keep the suite output readable.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => consoleError.mockRestore());

  it("renders nothing, and does not report, when production does not serve the query yet", () => {
    // The Inspector half of MJ-003 deployed before its backend half. That
    // throw used to escape to the route boundary and take the Servers page
    // down for anyone opening a hosted server's details.
    useQueryMock.mockImplementation(() => {
      throw PROD_DARK_SHIP;
    });

    const { container } = render(
      <ServerCredentialRecovery serverId="srv_1" server={recoveryServer} auth={recoveryAuth} />
    );

    expect(container).toBeEmptyDOMElement();
    expect(reportBoundaryError).not.toHaveBeenCalled();
  });

  it("treats the dev-deployment shape of a missing function the same way", () => {
    useQueryMock.mockImplementation(() => {
      throw DEV_DARK_SHIP;
    });

    const { container } = render(
      <ServerCredentialRecovery serverId="srv_1" server={recoveryServer} auth={recoveryAuth} />
    );

    expect(container).toBeEmptyDOMElement();
    expect(reportBoundaryError).not.toHaveBeenCalled();
  });

  it("still renders nothing but DOES report a failure it did not expect", () => {
    // The predicate is narrow on purpose: a boundary that suppressed
    // everything would also swallow the real bug it exists to surface.
    useQueryMock.mockImplementation(() => {
      throw new Error("kaboom");
    });

    const { container } = render(
      <ServerCredentialRecovery serverId="srv_1" server={recoveryServer} auth={recoveryAuth} />
    );

    expect(container).toBeEmptyDOMElement();
    expect(reportBoundaryError).toHaveBeenCalledTimes(1);
  });

  it("re-probes for the next server after one has failed", () => {
    // A boundary that has caught stays in its fallback for the life of the
    // element. Keyed by server, a failure on one does not hide history on
    // the next one opened in the same modal.
    //
    // Persistent, not `Once`: React retries a render that threw concurrently
    // before handing it to a boundary, and a one-shot throw lets that retry
    // succeed — which React then reports as an uncaught recovery error.
    useQueryMock.mockImplementation(() => {
      throw PROD_DARK_SHIP;
    });
    const { rerender } = render(
      <ServerCredentialRecovery serverId="srv_1" server={recoveryServer} auth={recoveryAuth} />
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    useQueryMock.mockReset();
    useQueryMock.mockReturnValue([urlChange]);
    rerender(
      <ServerCredentialRecovery serverId="srv_2" server={recoveryServer} auth={recoveryAuth} />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Re-enter the request headers and bearer token to reconnect."
    );
  });

  it("renders one row per edit when the backend answers", () => {
    useQueriesMock.mockReturnValue({ result: [urlChange, urlChangeClear] });

    render(history);

    const [{ result }] = useQueriesMock.mock.calls[0];
    expect(getFunctionName(result.query)).toBe(SERVER_URL_CHANGES_QUERY);
    expect(result.args).toEqual({ serverId: "srv_1" });
    expect(screen.getByText("https://old.example.com")).toBeInTheDocument();
    expect(screen.getByText("https://new.example.com")).toBeInTheDocument();
    expect(screen.getByText(/editor@example\.com/)).toBeInTheDocument();
    // Duplicate labels collapse, and the clear that accompanies a url repoint
    // does not get a second row — one edit, one row.
    expect(
      screen.getByText("Cleared request headers and bearer token.")
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("renders a stdio command swap, which writes no url event at all", () => {
    // mcpjam-backend#1260. A stdio row's destination is its command, so the
    // only record of the edit is the clear — filtering to `server.url.changed`
    // left this vector invisible in the panel.
    useQueriesMock.mockReturnValue({ result: [
      {
        id: "evt_stdio",
        action: "server.credentials.cleared_on_origin_change",
        actorEmail: "editor@example.com",
        timestamp: Date.UTC(2026, 8, 9, 12, 0, 0),
        metadata: {
          cause: "stdio_target_change",
          previousOrigin: null,
          nextOrigin: null,
          clearedKinds: ["env"],
        },
      },
    ] });

    render(history);

    expect(
      screen.getByText("Server command changed")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Cleared environment variables."
      )
    ).toBeInTheDocument();
    // No origins to show, and none invented.
    expect(screen.queryByText("null")).not.toBeInTheDocument();
  });

  it("does not claim a URL change when the row only stopped using its URL", () => {
    // A flip to stdio fires the url event with `nextOrigin: null` while the row
    // KEEPS its url. Reading that as a repoint tells the user their URL moved
    // while the field in front of them still shows the old one.
    useQueriesMock.mockReturnValue({ result: [
      {
        ...urlChange,
        id: "evt_flip",
        metadata: {
          ...urlChange.metadata,
          nextOrigin: null,
          viaTransportFlip: true,
          clearedKinds: ["env"],
        },
      },
    ] });

    render(history);

    expect(
      screen.getByText(/Switched to a local command/)
    ).toBeInTheDocument();
    expect(screen.queryByText("Server URL changed")).not.toBeInTheDocument();
    expect(
      screen.queryByText("https://old.example.com")
    ).not.toBeInTheDocument();
  });

  it("skips the query while the server id is unresolved", () => {
    const { container } = render(
      <ServerCredentialRecovery serverId={null} server={recoveryServer} auth={recoveryAuth} />
    );

    expect(useQueryMock).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("orders both event types by time and compares a revision with the previous revision", () => {
    const revisions = [
      { revisionNumber: 3, capturedAt: urlChange.timestamp + 60_000, counts: { tools: 5 } },
      { revisionNumber: 2, capturedAt: urlChange.timestamp - 60_000, counts: { tools: 3 } },
      { revisionNumber: 1, capturedAt: new Date(2026, 8, 8, 12).getTime(), counts: { tools: 1 } },
    ];
    const sameOriginChange = {
      ...urlChange,
      id: "evt_path",
      timestamp: urlChange.timestamp - 120_000,
      metadata: {
        previousOrigin: urlChange.metadata.nextOrigin,
        nextOrigin: urlChange.metadata.nextOrigin,
        clearedOnOriginChange: false,
      },
    };
    useQueriesMock.mockReturnValue({ result: [sameOriginChange, urlChange] });
    useQueryMock.mockImplementation((query: string) => {
      if (query === "serverInspections:listInspectionRevisions") return revisions;
      if (query === "serverInspections:diffInspectionRevisions") return null;
      return { counts: { tools: 0 }, snapshot: { tools: [] } };
    });

    render(history);

    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent(/Revision 3\+2 tools/);
    expect(rows[1]).toHaveTextContent("Server URL changed");
    expect(rows[2]).toHaveTextContent("Revision 2");
    expect(rows[3]).toHaveTextContent("Within");
    expect(rows[3]).not.toHaveTextContent("Cleared");
    expect(rows[4]).toHaveTextContent("Revision 1");

    const latest = screen.getByRole("button", { name: /Revision 3/ });
    expect(latest).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(latest);
    expect(latest).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /diff/i })).toHaveAttribute("aria-pressed", "true");
    expect(useQueryMock).toHaveBeenCalledWith("serverInspections:diffInspectionRevisions", {
      projectId: "proj_1",
      serverId: "srv_1",
      fromRevisionNumber: 2,
      toRevisionNumber: 3,
    });
    fireEvent.click(screen.getByRole("button", { name: /snapshot/i }));
    expect(screen.getByText("No tools")).toBeInTheDocument();
    fireEvent.click(latest);
    expect(latest).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("No tools")).not.toBeInTheDocument();
  });

  it("keeps revisions available when the URL change query fails", () => {
    useQueriesMock.mockReturnValue({ result: DEV_DARK_SHIP });
    useQueryMock.mockReturnValue([
      { revisionNumber: 1, capturedAt: urlChange.timestamp, counts: { tools: 1 } },
    ]);
    const { rerender } = render(history);

    expect(screen.getByRole("button", { name: /Revision 1/ })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    useQueriesMock.mockReturnValue({ result: new Error("Server not found") });
    rerender(<ServerHistoryContent projectId="proj_1" serverId="srv_1" />);
    expect(screen.getByRole("button", { name: /Revision 1/ })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Server URL and command changes unavailable");
  });

  it("uses a single empty state when neither history has events", () => {
    render(history);

    expect(screen.getByText("No server activity yet")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("offers recovery after a forbidden response at the new address", () => {
    useQueryMock.mockReturnValue([urlChange]);
    const server = createServer({
      config: { url: "https://new.example.com/mcp" },
      connectionStatus: "failed",
      lastError: "HTTP 403 Forbidden",
    });
    const auth = { method: "bearer", bearer: null, headers: null } as const;
    const { rerender } = render(
      <ServerCredentialRecovery serverId="srv_1" server={server} auth={auth} />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "The URL change cleared the request headers and bearer token. Check which credentials the server requires."
    );

    rerender(
      <ServerCredentialRecovery
        serverId="srv_1"
        server={{ ...server, lastError: "HTTP 403 Forbidden: IP is not allowed" }}
        auth={auth}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "The URL change cleared the request headers and bearer token. Check which credentials the server requires."
    );

    rerender(
      <ServerCredentialRecovery
        serverId="srv_1"
        server={server}
        auth={{ ...auth, bearer: { kind: "stored" }, headers: { kind: "stored" } }}
      />
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    rerender(
      <ServerCredentialRecovery
        serverId="srv_1"
        server={{ ...server, lastError: "HTTP 503 Service Unavailable" }}
        auth={auth}
      />
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("offers client-secret recovery for Automatic auth with preregistered credentials", () => {
    useQueryMock.mockReturnValue([
      {
        ...urlChange,
        metadata: { ...urlChange.metadata, clearedKinds: ["client_secret"] },
      },
    ]);
    const server = createServer({
      config: { url: "https://new.example.com/mcp" },
      connectionStatus: "failed",
      lastError: "HTTP 401 Unauthorized",
      registrationMode: "preregistered",
      hasClientSecret: false,
    });

    render(
      <ServerCredentialRecovery
        serverId="srv_1"
        server={server}
        auth={{ method: "auto", bearer: null, headers: null }}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Re-enter the OAuth client secret to reconnect."
    );
  });
});

describe("isServerUrlHistoryUnavailable", () => {
  it("names both dark-ship shapes of THIS query only", () => {
    expect(isServerUrlHistoryUnavailable(PROD_DARK_SHIP)).toBe(true);
    expect(isServerUrlHistoryUnavailable(DEV_DARK_SHIP)).toBe(true);
    // Another query's redacted failure is not this panel's to suppress.
    expect(
      isServerUrlHistoryUnavailable(
        new Error("[CONVEX Q(servers:get)] [Request ID: x] Server Error")
      )
    ).toBe(false);
    // A ConvexError from this query carries its own message and still reports.
    expect(
      isServerUrlHistoryUnavailable(
        new Error(
          `[CONVEX Q(${SERVER_URL_CHANGES_QUERY})] [Request ID: x] Uncaught ConvexError: Server not found`
        )
      )
    ).toBe(false);
    expect(isServerUrlHistoryUnavailable(new Error("kaboom"))).toBe(false);
  });
});
