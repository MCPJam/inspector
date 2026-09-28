import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { useQueryMock, reportBoundaryError } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
  reportBoundaryError: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@/lib/error-reporting", () => ({
  reportBoundaryError,
  reportCaught: vi.fn(),
}));

import {
  SERVER_URL_CHANGES_QUERY,
  ServerUrlChangeHistory,
  isServerUrlHistoryUnavailable,
} from "../ServerUrlChangeHistory";

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
  timestamp: Date.UTC(2026, 8, 9, 12, 0, 0),
  metadata: {
    cause: "url_origin_change",
    previousOrigin: "https://old.example.com",
    nextOrigin: "https://new.example.com",
    clearedOnOriginChange: true,
    viaTransportFlip: false,
    clearedKinds: ["headers", "legacy_headers"],
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

describe("ServerUrlChangeHistory", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useQueryMock.mockReset();
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

    const { container } = render(<ServerUrlChangeHistory serverId="srv_1" />);

    expect(container).toBeEmptyDOMElement();
    expect(reportBoundaryError).not.toHaveBeenCalled();
  });

  it("treats the dev-deployment shape of a missing function the same way", () => {
    useQueryMock.mockImplementation(() => {
      throw DEV_DARK_SHIP;
    });

    const { container } = render(<ServerUrlChangeHistory serverId="srv_1" />);

    expect(container).toBeEmptyDOMElement();
    expect(reportBoundaryError).not.toHaveBeenCalled();
  });

  it("still renders nothing but DOES report a failure it did not expect", () => {
    // The predicate is narrow on purpose: a boundary that suppressed
    // everything would also swallow the real bug it exists to surface.
    useQueryMock.mockImplementation(() => {
      throw new Error("kaboom");
    });

    const { container } = render(<ServerUrlChangeHistory serverId="srv_1" />);

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
    const { rerender } = render(<ServerUrlChangeHistory serverId="srv_1" />);
    expect(screen.queryByText("Destination history")).not.toBeInTheDocument();

    useQueryMock.mockReset();
    useQueryMock.mockReturnValue([urlChange]);
    rerender(<ServerUrlChangeHistory serverId="srv_2" />);

    expect(screen.getByText("Destination history")).toBeInTheDocument();
  });

  it("renders one row per edit when the backend answers", () => {
    useQueryMock.mockReturnValue([urlChange, urlChangeClear]);

    render(<ServerUrlChangeHistory serverId="srv_1" />);

    expect(useQueryMock).toHaveBeenCalledWith(SERVER_URL_CHANGES_QUERY, {
      serverId: "srv_1",
    });
    expect(screen.getByText("https://old.example.com")).toBeInTheDocument();
    expect(screen.getByText("https://new.example.com")).toBeInTheDocument();
    expect(screen.getByText(/editor@example\.com/)).toBeInTheDocument();
    // Duplicate labels collapse, and the clear that accompanies a url repoint
    // does not get a second row — one edit, one row.
    expect(
      screen.getByText(/Saved credentials were cleared.*request headers\./)
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("renders a stdio command swap, which writes no url event at all", () => {
    // mcpjam-backend#1260. A stdio row's destination is its command, so the
    // only record of the edit is the clear — filtering to `server.url.changed`
    // left this vector invisible in the panel.
    useQueryMock.mockReturnValue([
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
    ]);

    render(<ServerUrlChangeHistory serverId="srv_1" />);

    expect(
      screen.getByText("Pointed at a different command")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Saved credentials were cleared.*environment variables\./
      )
    ).toBeInTheDocument();
    // No origins to show, and none invented.
    expect(screen.queryByText("null")).not.toBeInTheDocument();
  });

  it("does not claim a URL change when the row only stopped using its URL", () => {
    // A flip to stdio fires the url event with `nextOrigin: null` while the row
    // KEEPS its url. Reading that as a repoint tells the user their URL moved
    // while the field in front of them still shows the old one.
    useQueryMock.mockReturnValue([
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
    ]);

    render(<ServerUrlChangeHistory serverId="srv_1" />);

    expect(
      screen.getByText(/Switched to a local command/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/URL changed/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("https://old.example.com")
    ).not.toBeInTheDocument();
  });

  it("skips the query while the server id is unresolved", () => {
    useQueryMock.mockReturnValue(undefined);

    const { container } = render(<ServerUrlChangeHistory serverId={null} />);

    expect(useQueryMock).toHaveBeenCalledWith(SERVER_URL_CHANGES_QUERY, "skip");
    expect(container).toBeEmptyDOMElement();
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
