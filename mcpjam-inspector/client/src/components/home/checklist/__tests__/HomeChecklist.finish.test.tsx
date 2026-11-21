import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HomeChecklist } from "../HomeChecklist";
import { checklistProgressKey } from "../checklist-progress";
import { track } from "@/lib/analytics";

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
  vi.mocked(track).mockClear();
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
  expect(screen.getByText("You're all set.")).toBeVisible();
  act(() => vi.advanceTimersByTime(1000));
  expect(onFinished).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(600));
  expect(onFinished).toHaveBeenCalled();
  expect(stored().finished).toBe(true);
});

it("grows the bar from the count Home last showed", () => {
  vi.useFakeTimers();
  window.localStorage.setItem(key, JSON.stringify({ shown: 2 }));
  render(<HomeChecklist onFinished={vi.fn()} />);
  expect(screen.getByText("2 of 5 set up")).toBeVisible();
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByText("3 of 5 set up")).toBeVisible();
  expect(stored().shown).toBe(3);
});

const completedSteps = () =>
  vi
    .mocked(track)
    .mock.calls.filter(
      ([name, props]) =>
        name === "home_checklist_step" && props?.action === "completed",
    )
    .map(([, props]) => [props?.step, props?.already_done]);

it("reports each step's completion once, marking ones done before the checklist", () => {
  window.localStorage.setItem(key, JSON.stringify({ reported: ["connect"] }));
  const view = render(<HomeChecklist onFinished={vi.fn()} />);
  expect(completedSteps()).toEqual([
    ["check_server", false],
    ["create_eval", false],
  ]);
  act(() => {
    window.localStorage.setItem(
      key,
      JSON.stringify({ ...stored(), chat: true }),
    );
    window.dispatchEvent(new Event("mcpjam:home-checklist-progress"));
  });
  view.unmount();
  render(<HomeChecklist onFinished={vi.fn()} />);
  expect(completedSteps()).toEqual([
    ["check_server", false],
    ["create_eval", false],
    ["chat", false],
  ]);
});

it("marks steps already done on the checklist's first load", () => {
  render(<HomeChecklist onFinished={vi.fn()} />);
  expect(completedSteps()).toEqual([
    ["connect", true],
    ["check_server", true],
    ["create_eval", true],
  ]);
});

it("reports the finish with its outcome", () => {
  vi.useFakeTimers();
  window.localStorage.setItem(key, JSON.stringify({ chat: true }));
  render(<HomeChecklist onFinished={vi.fn()} />);
  act(() => {
    window.localStorage.setItem(
      key,
      JSON.stringify({ ...stored(), agent: true }),
    );
    window.dispatchEvent(new Event("mcpjam:home-checklist-progress"));
  });
  act(() => vi.advanceTimersByTime(1600));
  expect(track).toHaveBeenCalledWith("home_checklist_finished", {
    location: "home",
    outcome: "completed",
    done_count: 5,
    already_done: false,
  });
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

it("still holds on 5 of 5 when the last step finished away from Home", () => {
  vi.useFakeTimers();
  window.localStorage.setItem(
    key,
    JSON.stringify({ chat: true, agent: true, reported: ["connect", "chat"] }),
  );
  const onFinished = vi.fn();
  render(<HomeChecklist onFinished={onFinished} />);
  expect(screen.getByText("5 of 5 set up")).toBeVisible();
  expect(onFinished).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1600));
  expect(onFinished).toHaveBeenCalled();
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
