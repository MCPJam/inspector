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
    render(<ConformanceHistory projectId="proj_1" serverId="srv_1" />);

    await user.click(screen.getByTestId("conformance-history-row"));

    expect(navigateMock).toHaveBeenCalledWith(
      "/conformance/runs/run_existing?project=proj_1",
    );
    expect(startRun).not.toHaveBeenCalled();
  });
});
