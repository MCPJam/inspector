import { describe, expect, it } from "vitest";
import {
  buildEvalsPath,
  buildEvalsRunsPath,
  buildEvaluatePath,
} from "../app-navigation";
import { parseEvalRouteFromUrl } from "../eval-route-url";
import type { EvalRoute } from "../eval-route-types";
import { redirectSuiteEditToSettings } from "@/router";
import { suiteEditRoute } from "@/components/evals/create-suite-navigation";

const builders = [
  ["/evaluate", buildEvaluatePath],
  ["/evals", buildEvalsPath],
  ["/evals/runs", buildEvalsRunsPath],
] as const;

function parse(prefix: string, url: string) {
  const [path, search] = url.split("?");
  return parseEvalRouteFromUrl(
    prefix as "/evaluate",
    path,
    search ? `?${search}` : "",
  );
}

describe("Suite settings addresses", () => {
  it.each(builders)("%s builds /settings and reads it back", (prefix, build) => {
    const settings: EvalRoute = { type: "suite-edit", suiteId: "s1" };
    expect(build(settings)).toBe(`${prefix}/suite/s1/settings`);
    expect(parse(prefix, build(settings))).toEqual(settings);

    const evaluators: EvalRoute = {
      type: "suite-edit",
      suiteId: "s1",
      tab: "evaluators",
      fromCaseChecks: "c1",
    };
    expect(build(evaluators)).toBe(
      `${prefix}/suite/s1/settings/evaluators?fromCaseChecks=c1`,
    );
    expect(parse(prefix, build(evaluators))).toEqual(evaluators);
  });

  it("still reads the old /edit address as Suite settings", () => {
    expect(parse("/evals", "/evals/suite/s1/edit")).toEqual({
      type: "suite-edit",
      suiteId: "s1",
    });
    // Only a case's evaluators linked here with fromCaseChecks.
    expect(parse("/evals", "/evals/suite/s1/edit?fromCaseChecks=c1")).toEqual({
      type: "suite-edit",
      suiteId: "s1",
      tab: "evaluators",
      fromCaseChecks: "c1",
    });
  });

  it("redirects /edit to /settings, keeping the prefix and query; case links open evaluators", () => {
    const response = redirectSuiteEditToSettings({
      request: new Request(
        "http://localhost/p/proj/evaluate/suite/s1/edit?fromCaseChecks=c1",
      ),
    });
    expect(response.headers.get("Location")).toBe(
      "/p/proj/evaluate/suite/s1/settings/evaluators?fromCaseChecks=c1",
    );
    expect(
      redirectSuiteEditToSettings({
        request: new Request("http://localhost/p/proj/evals/suite/s1/edit"),
      }).headers.get("Location"),
    ).toBe("/p/proj/evals/suite/s1/settings");
  });
});

describe("suiteEditRoute", () => {
  it("keeps the tab and the case to return to, for every navigation", () => {
    expect(suiteEditRoute("s1", "c1", "evaluators")).toEqual({
      type: "suite-edit",
      suiteId: "s1",
      fromCaseChecks: "c1",
      tab: "evaluators",
    });
    expect(suiteEditRoute("s1", undefined, "settings")).toEqual({
      type: "suite-edit",
      suiteId: "s1",
    });
  });
});
