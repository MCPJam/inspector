import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { track } from "@/lib/analytics";
import { useSuitePageViewed } from "../use-suite-page-viewed";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const views = () =>
  vi
    .mocked(track)
    .mock.calls.filter(([event]) => event === "eval_nav_page_viewed");

describe("useSuitePageViewed", () => {
  afterEach(() => vi.mocked(track).mockClear());

  it("sends one view per suite with ids only", () => {
    const { rerender } = renderHook((props) => useSuitePageViewed(props), {
      initialProps: { enabled: true, projectId: "project-1", suiteId: "s1" },
    });
    rerender({ enabled: true, projectId: "project-1", suiteId: "s1" });
    expect(views()).toEqual([
      [
        "eval_nav_page_viewed",
        {
          location: "evaluate_tab",
          page: "suite",
          tab: null,
          ui: "nav",
          project_id: "project-1",
        },
      ],
    ]);
    rerender({ enabled: true, projectId: "project-1", suiteId: "s2" });
    expect(views()).toHaveLength(2);
  });

  it("waits for the flag and sends nothing while it is off", () => {
    const { rerender } = renderHook((props) => useSuitePageViewed(props), {
      initialProps: { enabled: false, projectId: null, suiteId: "s1" },
    });
    expect(views()).toEqual([]);
    rerender({ enabled: true, projectId: null, suiteId: "s1" });
    expect(views()).toHaveLength(1);
    expect(views()[0][1]).toMatchObject({ project_id: null });
  });
});
