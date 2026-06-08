import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useConvexAuthMock = vi.hoisted(() => vi.fn());
const authFetchMock = vi.hoisted(() => vi.fn());

vi.mock("convex/react", () => ({
  useQuery: useQueryMock,
  useConvexAuth: useConvexAuthMock,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: authFetchMock,
}));

import { RunChecksModal } from "../RunChecksModal";

function makeSuite(
  id: string,
  name: string,
  predicates: Array<{ type: string } & Record<string, unknown>>,
  updatedAt = 0,
) {
  return {
    suite: {
      _id: id,
      name,
      defaultPredicates: predicates,
      configRevision: "rev-1",
      updatedAt,
    },
    latestRun: null,
    recentRuns: [],
    passRateTrend: [],
    totals: { passed: 0, failed: 0, runs: 0 },
  };
}

describe("<RunChecksModal>", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useConvexAuthMock.mockReset();
    authFetchMock.mockReset();
    useConvexAuthMock.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it("renders a no-suites empty state when the project has no suites", () => {
    useQueryMock.mockReturnValue([]);
    render(
      <RunChecksModal
        open
        onOpenChange={vi.fn()}
        chatSessionId="sess-1"
        projectId="proj-1"
      />,
    );
    expect(screen.getByTestId("run-checks-no-suites")).toBeInTheDocument();
  });

  it("lists suites, defaults to the newest, and previews its predicates", () => {
    useQueryMock.mockReturnValue([
      makeSuite(
        "suite-old",
        "Older",
        [{ type: "noToolErrors" }],
        1,
      ),
      makeSuite(
        "suite-new",
        "Newer",
        [
          { type: "toolCalledAtLeastOnce", toolName: "search" },
          { type: "tokenBudgetUnder", tokens: 500 },
        ],
        100,
      ),
    ]);
    render(
      <RunChecksModal
        open
        onOpenChange={vi.fn()}
        chatSessionId="sess-1"
        projectId="proj-1"
      />,
    );
    const select = screen.getByTestId(
      "run-checks-suite-select",
    ) as HTMLSelectElement;
    expect(select.value).toBe("suite-new");
    expect(screen.getByText(/Checks to run \(2\)/)).toBeInTheDocument();
    expect(screen.getByText("toolCalledAtLeastOnce")).toBeInTheDocument();
    expect(screen.getByText("tokenBudgetUnder")).toBeInTheDocument();
  });

  it("posts to /api/web/checks/run-predicates with the selected suite on Run", async () => {
    useQueryMock.mockReturnValue([
      makeSuite(
        "suite-1",
        "Suite One",
        [{ type: "noToolErrors" }],
      ),
    ]);
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ checkRunId: "run-1", results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const onOpenChange = vi.fn();
    render(
      <RunChecksModal
        open
        onOpenChange={onOpenChange}
        chatSessionId="sess-1"
        projectId="proj-1"
      />,
    );
    fireEvent.click(screen.getByTestId("run-checks-submit"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = authFetchMock.mock.calls[0];
    expect(url).toBe("/api/web/checks/run-predicates");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      chatSessionId: "sess-1",
      setKind: "suite_defaults",
      setRef: "suite-1",
      setVersion: "rev-1",
      predicates: [{ type: "noToolErrors" }],
    });
    // Modal closes on success.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("surfaces an inline error and offers a retry when the route returns non-OK", async () => {
    useQueryMock.mockReturnValue([
      makeSuite(
        "suite-1",
        "Suite One",
        [{ type: "noToolErrors" }],
      ),
    ]);
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Server is on fire" }), {
        status: 500,
      }),
    );
    const onOpenChange = vi.fn();
    render(
      <RunChecksModal
        open
        onOpenChange={onOpenChange}
        chatSessionId="sess-1"
        projectId="proj-1"
      />,
    );
    fireEvent.click(screen.getByTestId("run-checks-submit"));

    const alert = await screen.findByTestId("run-checks-error");
    expect(alert).toHaveTextContent(/Server is on fire/);
    expect(screen.getByTestId("run-checks-submit")).toHaveTextContent(/Retry/);
    // Modal stays open on failure so the user can retry.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("disables the submit button when the selected suite has zero default predicates", () => {
    useQueryMock.mockReturnValue([makeSuite("suite-empty", "Empty", [])]);
    render(
      <RunChecksModal
        open
        onOpenChange={vi.fn()}
        chatSessionId="sess-1"
        projectId="proj-1"
      />,
    );
    expect(screen.getByTestId("run-checks-no-predicates")).toBeInTheDocument();
    expect(screen.getByTestId("run-checks-submit")).toBeDisabled();
  });
});
