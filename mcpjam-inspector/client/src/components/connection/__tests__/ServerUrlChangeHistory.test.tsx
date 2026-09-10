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
  `[CONVEX Q(${SERVER_URL_CHANGES_QUERY})] [Request ID: 5eb87f6c9d3ef8d5] Server Error\n  Called by client`,
);
const DEV_DARK_SHIP = new Error(
  `[CONVEX Q(${SERVER_URL_CHANGES_QUERY})] [Request ID: abc] Could not find public function for '${SERVER_URL_CHANGES_QUERY}'`,
);

const urlChange = {
  _id: "evt_1",
  action: "server.url.changed",
  actorEmail: "editor@example.com",
  timestamp: Date.UTC(2026, 8, 9, 12, 0, 0),
  metadata: {
    previousOrigin: "https://old.example.com",
    nextOrigin: "https://new.example.com",
    originChanged: true,
    clearedOnOriginChange: true,
    clearedKinds: ["headers", "legacy_headers"],
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
    expect(screen.queryByText("URL history")).not.toBeInTheDocument();

    useQueryMock.mockReset();
    useQueryMock.mockReturnValue([urlChange]);
    rerender(<ServerUrlChangeHistory serverId="srv_2" />);

    expect(screen.getByText("URL history")).toBeInTheDocument();
  });

  it("renders the history when the backend answers", () => {
    useQueryMock.mockReturnValue([
      urlChange,
      { ...urlChange, _id: "evt_2", action: "server.credentials.cleared" },
    ]);

    render(<ServerUrlChangeHistory serverId="srv_1" />);

    expect(useQueryMock).toHaveBeenCalledWith(SERVER_URL_CHANGES_QUERY, {
      serverId: "srv_1",
    });
    expect(screen.getByText("https://old.example.com")).toBeInTheDocument();
    expect(screen.getByText("https://new.example.com")).toBeInTheDocument();
    expect(screen.getByText(/editor@example\.com/)).toBeInTheDocument();
    // Duplicate labels collapse, and only the url-change row renders.
    expect(
      screen.getByText(/Saved credentials were cleared.*request headers\./),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
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
        new Error("[CONVEX Q(servers:get)] [Request ID: x] Server Error"),
      ),
    ).toBe(false);
    // A ConvexError from this query carries its own message and still reports.
    expect(
      isServerUrlHistoryUnavailable(
        new Error(
          `[CONVEX Q(${SERVER_URL_CHANGES_QUERY})] [Request ID: x] Uncaught ConvexError: Server not found`,
        ),
      ),
    ).toBe(false);
    expect(isServerUrlHistoryUnavailable(new Error("kaboom"))).toBe(false);
  });
});
