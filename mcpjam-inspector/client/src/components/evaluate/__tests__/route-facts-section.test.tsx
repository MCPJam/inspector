import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { EvalRunRouteFactsCase } from "@mcpjam/sdk/contract";

import { RouteFactsSection } from "../route-facts-section";

afterEach(cleanup);

const facts = (
  over: Partial<EvalRunRouteFactsCase> = {},
): EvalRunRouteFactsCase =>
  ({
    caseVariantKey: "case_a\u0000",
    caseKey: "case_a",
    routes: {
      population: "trial",
      totalTrials: 3,
      includedTrials: 3,
      exclusions: {},
      routes: [
        { pathKey: "tool_a→tool_b", trials: 2, passed: 2, failed: 0 },
        { pathKey: "no_tools", trials: 1, passed: 0, failed: 1 },
      ],
      tags: {
        noToolCalled: {
          state: "measured",
          value: 1 / 3,
          numerator: 1,
          denominator: 3,
          exclusions: {},
        },
        retried: {
          state: "measured",
          value: 0,
          numerator: 0,
          denominator: 3,
          exclusions: {},
        },
        looping: {
          state: "measured",
          value: 0,
          numerator: 0,
          denominator: 3,
          exclusions: {},
        },
      },
      loopedOn: [],
      endedWithQuestion: {
        state: "notMeasured",
        value: null,
        numerator: 0,
        denominator: 0,
        exclusions: {},
      },
    },
    mismatch: {
      state: "measured",
      expected: [
        {
          tool: "tool_a",
          expectedIn: 3,
          notCalledIn: 1,
          notCalledInFailed: 1,
        },
      ],
      unexpected: [],
      substitutions: [],
    },
    ...over,
  }) as EvalRunRouteFactsCase;

describe("RouteFactsSection", () => {
  it("renders two collapsed expanders", () => {
    render(<RouteFactsSection facts={facts()} catalogState="loaded" />);
    const section = screen.getByTestId("route-facts-section");
    expect(section).toBeInTheDocument();
    const routes = screen.getByText("Routes").closest("details");
    const mismatch = screen.getByText("Expected vs observed").closest("details");
    expect(routes).not.toHaveAttribute("open");
    expect(mismatch).not.toHaveAttribute("open");
    expect(section).toHaveTextContent("expected `tool_a` not called in 1 of 3");
    expect(section).toHaveTextContent("ended with a question: not measured");
  });

  it("omits the mismatch expander for a negative test", () => {
    render(
      <RouteFactsSection
        facts={facts({ mismatch: { state: "excludedNegativeTest" } })}
        catalogState="loaded"
      />,
    );
    expect(screen.queryByText("Expected vs observed")).toBeNull();
    expect(screen.getByText(/Negative test/)).toBeInTheDocument();
  });
});
