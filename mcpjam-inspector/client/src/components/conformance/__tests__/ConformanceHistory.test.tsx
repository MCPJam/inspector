import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConformanceRunListItem } from "../ConformanceHistory";

const { navigateMock, startRun, useQueryMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  startRun: vi.fn().mockResolvedValue({ runId: "run_new" }),
  useQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useMutation: (name: string) => {
    if (name === "conformanceRuns:startRun") return startRun;
    return vi.fn();
  },
  useAction: () => vi.fn(),
}));

vi.mock("@/lib/app-navigation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/app-navigation")>();
  return {
    ...actual,
    useAppNavigate: () => navigateMock,
  };
});

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => false,
}));

import { ConformanceHistory } from "../ConformanceHistory";

function makeRun(
  overrides: Partial<ConformanceRunListItem> = {},
): ConformanceRunListItem {
  return {
    _id: "run_existing",
    projectId: "proj_1",
    targetKind: "server",
    targetKey: "server:srv_1",
    serverId: "srv_1",
    source: "ui",
    verification: "client_reported",
    status: "completed",
    outcome: "incomplete",
    incompleteReason: null,
    score: null,
    applicable: 4,
    passed: 0,
    failed: 0,
    couldNotRun: 4,
    requestedSuites: ["protocol", "apps", "tasks", "oauth"],
    protocolVersion: null,
    actorLabel: "Inspector UI",
    ciMetadata: null,
    createdAt: Date.now() - 60_000,
    completedAt: Date.now() - 60_000,
    durationMs: 0,
    sharingEnabled: false,
    ...overrides,
  };
}

describe("ConformanceHistory", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    startRun.mockClear();
    useQueryMock.mockReturnValue({
      page: [makeRun()],
      isDone: true,
      continueCursor: "",
    });
  });

  it("opens an existing run instead of starting a new one", async () => {
    const user = userEvent.setup();
    // A Convex-id-shaped project: the run link carries the project in its
    // PATH now, and the builder refuses to put an unusable id there.
    const projectId = "k5700000000000000000000000a";
    render(<ConformanceHistory projectId={projectId} serverId="srv_1" />);

    await user.click(screen.getByTestId("conformance-history-row"));

    // Not `?project=`: a run link has to reopen the same project on a
    // refresh, which a query the app consumes and strips cannot do.
    expect(navigateMock).toHaveBeenCalledWith(
      `/p/${projectId}/conformance/runs/run_existing`,
    );
    expect(startRun).not.toHaveBeenCalled();
  });
});
