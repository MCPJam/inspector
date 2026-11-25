import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";

const { useQueriesMock, useQueryMock } = vi.hoisted(() => ({
  useQueriesMock: vi.fn(),
  useQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQueries: (...args: unknown[]) => useQueriesMock(...args),
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { email: "viewer@example.com" } }),
}));

import {
  SERVER_URL_CHANGES_QUERY,
  isServerUrlHistoryUnavailable,
} from "../ServerUrlChangeHistory";
import { ServerHistoryContent } from "../ServerHistoryContent";

// Production redacts missing query errors to the query name and Server Error.
// Development exposes the missing function name.
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
  timestamp: urlChange.timestamp,
  metadata: {
    cause: "url_origin_change",
    previousOrigin: "https://old.example.com",
    nextOrigin: "https://new.example.com",
    clearedKinds: ["headers"],
  },
};

const history = <ServerHistoryContent projectId="proj_1" serverId="srv_1" />;

describe("Server History", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue([]);
    useQueriesMock.mockReset();
    useQueriesMock.mockReturnValue({ result: [] });
  });

  it("renders one row per edit when the backend answers", () => {
    useQueriesMock.mockReturnValue({ result: [urlChange, urlChangeClear] });

    render(history);

    const [{ result }] = useQueriesMock.mock.calls[0];
    expect(getFunctionName(result.query)).toBe(SERVER_URL_CHANGES_QUERY);
    expect(result.args).toEqual({ serverId: "srv_1" });
    expect(screen.getByText("From").nextElementSibling).toHaveTextContent(
      "https://old.example.com"
    );
    expect(screen.getByText("To").nextElementSibling).toHaveTextContent(
      "https://new.example.com"
    );
    expect(screen.getByText("Changed by editor@example.com")).toBeInTheDocument();
    // Duplicate labels collapse, and the clear that accompanies a url repoint
    // does not get a second row — one edit, one row.
    expect(
      screen.getByText("Cleared request headers and bearer token.")
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("labels the viewer's own changes and preserves their audit email", () => {
    useQueriesMock.mockReturnValue({
      result: [{ ...urlChange, actorEmail: "Viewer@example.com" }],
    });

    render(history);

    expect(screen.getByText("Changed by you")).toHaveAttribute(
      "title",
      "Viewer@example.com"
    );
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
    expect(within(rows[3]).getByText("Origin").nextElementSibling).toHaveTextContent(
      "https://new.example.com"
    );
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

  it("explains the revision limit and keeps older URL changes visible", () => {
    const revisions = Array.from({ length: 51 }, (_, index) => ({
      revisionNumber: 51 - index,
      capturedAt: urlChange.timestamp + (51 - index) * 60_000,
      counts: { tools: 1 },
    }));
    useQueryMock.mockReturnValue(revisions);
    useQueriesMock.mockReturnValue({ result: [urlChange] });

    render(history);

    expect(useQueryMock).toHaveBeenCalledWith("serverInspections:listInspectionRevisions", {
      projectId: "proj_1",
      serverId: "srv_1",
      limit: 51,
    });
    expect(screen.getByText("Only the latest 50 inspection revisions are shown.")).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(51);
    expect(screen.queryByRole("button", { name: /^Revision 1\b/ })).not.toBeInTheDocument();
    expect(screen.getByText("Server URL changed")).toBeVisible();
  });

  it.each([PROD_DARK_SHIP, DEV_DARK_SHIP])(
    "keeps revisions available when the audit query is missing",
    (error) => {
      useQueriesMock.mockReturnValue({ result: error });
      useQueryMock.mockReturnValue([
        { revisionNumber: 1, capturedAt: urlChange.timestamp, counts: { tools: 1 } },
      ]);

      render(history);

      expect(screen.getByRole("button", { name: /Revision 1/ })).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    }
  );

  it("shows the audit error and restores history when another server loads", () => {
    useQueriesMock.mockReturnValue({ result: new Error("Server not found") });
    useQueryMock.mockReturnValue([
      { revisionNumber: 1, capturedAt: urlChange.timestamp, counts: { tools: 1 } },
    ]);
    const { rerender } = render(history);

    expect(screen.getByRole("button", { name: /Revision 1/ })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Server URL and command changes unavailable"
    );

    useQueriesMock.mockReturnValue({ result: [urlChange] });
    rerender(<ServerHistoryContent key="srv_2" projectId="proj_1" serverId="srv_2" />);

    const [{ result }] = useQueriesMock.mock.calls.at(-1) ?? [];
    expect(result.args).toEqual({ serverId: "srv_2" });
    expect(screen.getByText("Server URL changed")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("uses a single empty state when neither history has events", () => {
    render(history);

    expect(screen.getByText("No server activity yet")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
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
