import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HomeChecklist } from "../HomeChecklist";
import { checklistProgressKey } from "../checklist-progress";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => vi.fn(),
  routePaths: {},
  buildConformanceRunPath: () => "/c",
  buildEvaluatePath: () => "/e",
}));
vi.mock("@/components/ui/error-card", () => ({ ErrorCard: () => null }));
vi.mock("@/hooks/use-soft-query", () => ({
  useSoftQuery: (name: string) => ({
    data: name.startsWith("conformance")
      ? [{ _id: "r", status: "completed", createdAt: 1, passed: 1, applicable: 1 }]
      : [
          {
            suite: { _id: "s", createdBy: "me" },
            latestRun: { status: "completed", createdBy: "me", summary: { passRate: 1 } },
            recentRuns: [],
          },
        ],
  }),
}));
vi.mock("@/lib/app-route-context", () => ({
  useAppRouteContext: () => ({
    projectServers: { Acme: { name: "Acme" } },
    appState: { servers: {} },
    convexProjectId: "p",
    currentUser: { _id: "me" },
    activeProject: { name: "Default" },
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

it("holds on 5 of 5 before handing Home back", () => {
  vi.useFakeTimers();
  window.localStorage.setItem(
    checklistProgressKey("me", "p"),
    JSON.stringify({ chat: true, agent: true }),
  );
  const onFinished = vi.fn();
  const view = render(<HomeChecklist onFinished={onFinished} />);
  expect(screen.getByText("5 of 5 set up")).toBeVisible();
  act(() => vi.advanceTimersByTime(1000));
  expect(onFinished).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(600));
  expect(onFinished).toHaveBeenCalledTimes(1);
  view.unmount();
});

it("cancels the hold when it unmounts first", () => {
  vi.useFakeTimers();
  window.localStorage.setItem(
    checklistProgressKey("me", "p"),
    JSON.stringify({ chat: true, agent: true }),
  );
  const onFinished = vi.fn();
  render(<HomeChecklist onFinished={onFinished} />).unmount();
  act(() => vi.advanceTimersByTime(2000));
  expect(onFinished).not.toHaveBeenCalled();
});

it("leaves right away when the user skipped the rest", () => {
  window.localStorage.setItem(
    checklistProgressKey("me", "p"),
    JSON.stringify({ skippedAll: true }),
  );
  const onFinished = vi.fn();
  render(<HomeChecklist onFinished={onFinished} />);
  expect(onFinished).toHaveBeenCalledTimes(1);
});
