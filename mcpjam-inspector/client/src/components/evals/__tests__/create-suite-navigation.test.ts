import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCiSuiteNavigation,
  createPlaygroundSuiteNavigation,
  navigatePlaygroundEvalsRoute,
} from "../create-suite-navigation";
import * as appNavigation from "@/lib/app-navigation";

describe("createCiSuiteNavigation", () => {
  let navigateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    navigateSpy = vi
      .spyOn(appNavigation, "navigateApp")
      .mockImplementation(() => undefined);
  });

  it("preserves fromCommit on toSuiteOverview when drill-down route has fromCommit", () => {
    const nav = createCiSuiteNavigation({
      type: "suite-overview",
      suiteId: "s1",
      fromCommit: "abc123",
    });
    nav.toSuiteOverview("s2", "runs");
    expect(navigateSpy).toHaveBeenCalledWith(
      "/ci-evals/suite/s2?fromCommit=abc123",
      { replace: undefined },
    );
  });

  it("does not add fromCommit when current route is not suite-overview with fromCommit", () => {
    const nav = createCiSuiteNavigation({
      type: "suite-overview",
      suiteId: "s1",
    });
    nav.toSuiteOverview("s2", "test-cases");
    expect(navigateSpy).toHaveBeenCalledWith(
      "/ci-evals/suite/s2?view=test-cases",
      { replace: undefined },
    );
  });
});

describe("createPlaygroundSuiteNavigation", () => {
  let navigateSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    navigateSpy = vi
      .spyOn(appNavigation, "navigateApp")
      .mockImplementation(() => undefined);
  });

  it("toSuiteOverview navigates to /evals/suite/:id", () => {
    const nav = createPlaygroundSuiteNavigation();
    nav.toSuiteOverview("suite-1", "runs");
    expect(navigateSpy).toHaveBeenCalledWith("/evals/suite/suite-1", {
      replace: undefined,
    });
  });

  it("toSuiteOverview can navigate to the user-facing Runs section", () => {
    const nav = createPlaygroundSuiteNavigation();
    nav.toSuiteOverview("suite-1", "executions");
    expect(navigateSpy).toHaveBeenCalledWith(
      "/evals/suite/suite-1?view=executions",
      { replace: undefined },
    );
  });

  it("toTestEdit emits compare links for results routes", () => {
    const nav = createPlaygroundSuiteNavigation();
    nav.toTestEdit("suite-1", "case-1", {
      openCompare: true,
      iteration: "iter-1",
    });
    expect(navigateSpy).toHaveBeenCalledWith(
      "/evals/suite/suite-1/test/case-1/edit?compare=1&iteration=iter-1",
      { replace: undefined },
    );
  });
});

describe("navigatePlaygroundEvalsRoute", () => {
  let navigateSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    navigateSpy = vi
      .spyOn(appNavigation, "navigateApp")
      .mockImplementation(() => undefined);
  });

  it("navigates to the playground evals list path", () => {
    navigatePlaygroundEvalsRoute({ type: "list" });
    expect(navigateSpy).toHaveBeenCalledWith("/evals", { replace: undefined });
  });

  it("passes the replace option through to navigateApp", () => {
    navigatePlaygroundEvalsRoute(
      { type: "run-detail", suiteId: "s1", runId: "r1" },
      { replace: true },
    );
    expect(navigateSpy).toHaveBeenCalledWith(
      "/evals/suite/s1/runs/r1",
      { replace: true },
    );
  });
});
