import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { EvaluateNavHost } from "../evaluate-nav-host";
import { EVALUATE_NAV_PAGES } from "../evaluate-nav-pages";

const flag = vi.hoisted(() => ({ value: undefined as boolean | undefined }));
const track = vi.hoisted(() => vi.fn());
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => flag.value,
  usePostHog: () => ({ featureFlags: { hasLoadedFlags: false } }),
  useActiveFeatureFlags: () => [],
}));
vi.mock("@/lib/analytics", () => ({ track }));

const TEST_RUN_URL = "/evaluate/suite/s_1/runs/r_1/cases/c_1";

function renderAt(url: string, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: url, state }]}>
      <EvaluateNavHost>
        <p>today</p>
      </EvaluateNavHost>
    </MemoryRouter>,
  );
}

describe("EvaluateNavHost", () => {
  beforeEach(() => {
    EVALUATE_NAV_PAGES["test-run"].Page = ({ route }) => (
      <p>new test run {route.caseId}</p>
    );
  });
  afterEach(() => {
    delete EVALUATE_NAV_PAGES["test-run"].Page;
    flag.value = undefined;
    track.mockClear();
  });

  it("renders today's page without waiting when the route has no new page", () => {
    renderAt("/evaluate/suite/s_1");
    expect(screen.getByText("today")).toBeTruthy();
  });

  it("waits for the flag before choosing a page", () => {
    const { container } = renderAt(TEST_RUN_URL);
    expect(container.textContent).toBe("");
    expect(track).not.toHaveBeenCalled();
  });

  it("renders today's page with the flag off", () => {
    flag.value = false;
    renderAt(TEST_RUN_URL);
    expect(screen.getByText("today")).toBeTruthy();
    expect(track).not.toHaveBeenCalled();
  });

  it("renders the new page with the flag on and records the view", () => {
    flag.value = true;
    renderAt(TEST_RUN_URL, { evalNavArrival: "crumb" });
    expect(screen.getByText("new test run c_1")).toBeTruthy();
    expect(track).toHaveBeenCalledWith("eval_nav_page_viewed", {
      location: "evaluate_nav",
      page: "test_run",
      arrived_via: "crumb",
    });
  });
});
