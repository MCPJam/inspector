import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCiSuiteNavigation,
  createPlaygroundSuiteNavigation,
  navigatePlaygroundEvalsRoute,
} from "../create-suite-navigation";
import * as ciEvalsRouter from "@/lib/ci-evals-router";
import * as evalsRouter from "@/lib/evals-router";
import * as testingSurface from "@/lib/testing-surface";

vi.spyOn(ciEvalsRouter, "navigateToCiEvalsRoute").mockImplementation(
  () => undefined as never,
);

describe("createCiSuiteNavigation", () => {
  beforeEach(() => {
    vi.mocked(ciEvalsRouter.navigateToCiEvalsRoute).mockClear();
  });

  it("preserves fromCommit on toSuiteOverview when drill-down route has fromCommit", () => {
    const nav = createCiSuiteNavigation({
      type: "suite-overview",
      suiteId: "s1",
      fromCommit: "abc123",
    });
    nav.toSuiteOverview("s2", "runs");
    expect(ciEvalsRouter.navigateToCiEvalsRoute).toHaveBeenCalledWith({
      type: "suite-overview",
      suiteId: "s2",
      view: "runs",
      fromCommit: "abc123",
    });
  });

  it("does not add fromCommit when current route is not suite-overview with fromCommit", () => {
    const nav = createCiSuiteNavigation({
      type: "suite-overview",
      suiteId: "s1",
    });
    nav.toSuiteOverview("s2", "test-cases");
    expect(ciEvalsRouter.navigateToCiEvalsRoute).toHaveBeenCalledWith({
      type: "suite-overview",
      suiteId: "s2",
      view: "test-cases",
    });
  });
});

describe("createPlaygroundSuiteNavigation", () => {
  beforeEach(() => {
    vi.spyOn(evalsRouter, "buildEvalsHash").mockImplementation((r) =>
      JSON.stringify(r),
    );
    vi.spyOn(testingSurface, "withTestingSurface").mockImplementation(
      (h) => `wrapped:${h}`,
    );
  });

  it("toSuiteOverview uses suite-overview with testing surface wrapper", () => {
    const nav = createPlaygroundSuiteNavigation();
    nav.toSuiteOverview("suite-1", "runs");
    expect(evalsRouter.buildEvalsHash).toHaveBeenCalledWith({
      type: "suite-overview",
      suiteId: "suite-1",
      view: "runs",
    });
    expect(testingSurface.withTestingSurface).toHaveBeenCalledWith(
      '{"type":"suite-overview","suiteId":"suite-1","view":"runs"}',
    );
  });

  it("toTestEdit emits compare links for results routes", () => {
    const nav = createPlaygroundSuiteNavigation();
    nav.toTestEdit("suite-1", "case-1", {
      openCompare: true,
      iteration: "iter-1",
    });
    expect(evalsRouter.buildEvalsHash).toHaveBeenCalledWith({
      type: "test-edit",
      suiteId: "suite-1",
      testId: "case-1",
      openCompare: true,
      iteration: "iter-1",
    });
  });
});

describe("navigatePlaygroundEvalsRoute", () => {
  beforeEach(() => {
    vi.spyOn(evalsRouter, "buildEvalsHash").mockImplementation((r) =>
      JSON.stringify(r),
    );
    vi.spyOn(testingSurface, "withTestingSurface").mockImplementation(
      (h) => `#${h}`,
    );
  });

  it("uses location hash navigation when replace is not set", () => {
    const replaceSpy = vi.spyOn(history, "replaceState");
    navigatePlaygroundEvalsRoute({ type: "list" });
    expect(evalsRouter.buildEvalsHash).toHaveBeenCalledWith({ type: "list" });
    expect(testingSurface.withTestingSurface).toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
    replaceSpy.mockRestore();
  });

  it("uses history.replaceState and hashchange when replace is true", () => {
    const replaceSpy = vi
      .spyOn(history, "replaceState")
      .mockImplementation(() => undefined);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    navigatePlaygroundEvalsRoute(
      { type: "run-detail", suiteId: "s1", runId: "r1" },
      { replace: true },
    );
    expect(replaceSpy).toHaveBeenCalledWith(
      {},
      "",
      '/#{"type":"run-detail","suiteId":"s1","runId":"r1"}',
    );
    expect(dispatchSpy).toHaveBeenCalledWith(expect.any(HashChangeEvent));
    replaceSpy.mockRestore();
  });
});
