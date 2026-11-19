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
const query = vi.hoisted(() => ({ loaded: true }));
vi.mock("@/hooks/use-soft-query", () => ({
  useSoftQuery: (name: string) => ({
    data: !query.loaded
      ? undefined
      : name.startsWith("conformance")
        ? [
            {
              _id: "r",
              status: "completed",
              createdAt: 1,
              passed: 1,
              applicable: 1,
            },
          ]
        : [
            {
              suite: { _id: "s", createdBy: "me" },
              latestRun: {
                status: "completed",
                createdBy: "me",
                summary: { passRate: 1 },
              },
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

const key = checklistProgressKey("me", "p");
const stored = () => JSON.parse(window.localStorage.getItem(key) ?? "{}");

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  query.loaded = true;
});

it("holds on 5 of 5 when the last step completes, then remembers it", () => {
  vi.useFakeTimers();
  window.localStorage.setItem(key, JSON.stringify({ chat: true }));
  const onFinished = vi.fn();
  render(<HomeChecklist onFinished={onFinished} />);
  expect(screen.getByText("4 of 5 set up")).toBeVisible();
  act(() => {
    window.localStorage.setItem(
      key,
      JSON.stringify({ chat: true, agent: true }),
    );
    window.dispatchEvent(new Event("mcpjam:home-checklist-progress"));
  });
  expect(screen.getByText("5 of 5 set up")).toBeVisible();
  act(() => vi.advanceTimersByTime(1000));
  expect(onFinished).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(600));
  expect(onFinished).toHaveBeenCalled();
  expect(stored().finished).toBe(true);
});

it("cancels the hold when it unmounts first", () => {
  vi.useFakeTimers();
  window.localStorage.setItem(key, JSON.stringify({ chat: true }));
  const onFinished = vi.fn();
  const view = render(<HomeChecklist onFinished={onFinished} />);
  act(() => {
    window.localStorage.setItem(
      key,
      JSON.stringify({ chat: true, agent: true }),
    );
    window.dispatchEvent(new Event("mcpjam:home-checklist-progress"));
  });
  view.unmount();
  act(() => vi.advanceTimersByTime(2000));
  expect(onFinished).not.toHaveBeenCalled();
  expect(stored().finished).toBeUndefined();
});

it("hands Home back without the hold when everything was already done", () => {
  window.localStorage.setItem(key, JSON.stringify({ chat: true, agent: true }));
  const onFinished = vi.fn();
  render(<HomeChecklist onFinished={onFinished} />);
  expect(onFinished).toHaveBeenCalled();
  expect(screen.queryByText("5 of 5 set up")).toBeNull();
  expect(stored().finished).toBe(true);
});

it("waits for conformance and eval answers before showing steps", () => {
  window.localStorage.setItem(key, JSON.stringify({ chat: true, agent: true }));
  query.loaded = false;
  const onFinished = vi.fn();
  const view = render(<HomeChecklist onFinished={onFinished} />);
  expect(screen.queryByText(/of 5 set up/)).toBeNull();
  expect(onFinished).not.toHaveBeenCalled();
  query.loaded = true;
  view.rerender(<HomeChecklist onFinished={onFinished} />);
  expect(onFinished).toHaveBeenCalled();
  expect(screen.queryByText("5 of 5 set up")).toBeNull();
});

it("stays on today's Home once finished", () => {
  window.localStorage.setItem(key, JSON.stringify({ finished: true }));
  const onFinished = vi.fn();
  render(<HomeChecklist onFinished={onFinished} />);
  expect(onFinished).toHaveBeenCalled();
  expect(screen.queryByText(/of 5 set up/)).toBeNull();
});

it("leaves right away when the user skipped the rest", () => {
  window.localStorage.setItem(key, JSON.stringify({ skippedAll: true }));
  const onFinished = vi.fn();
  render(<HomeChecklist onFinished={onFinished} />);
  expect(onFinished).toHaveBeenCalledTimes(1);
});
