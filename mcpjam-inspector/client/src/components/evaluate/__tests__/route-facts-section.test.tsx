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
      gradeableTrials: 3,
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
    const mismatch = screen
      .getByText("Expected vs observed")
      .closest("details");
    expect(routes).not.toHaveAttribute("open");
    expect(mismatch).not.toHaveAttribute("open");
    expect(section).toHaveTextContent("expected `tool_a` not called in 1 of 3");
    expect(section).toHaveTextContent("ended with a question: not measured");
    expect(section).toHaveTextContent(
      "counted by tool name — a call with the wrong arguments counts as called",
    );
    expect(screen.queryByTestId("route-facts-variant")).toBeNull();
  });

  it("counts a called-in line over gradeable trials, not included trials", () => {
    render(
      <RouteFactsSection
        facts={facts({
          routes: {
            ...facts().routes,
            includedTrials: 5,
            totalTrials: 5,
          },
          mismatch: {
            state: "measured",
            gradeableTrials: 3,
            expected: [],
            unexpected: [
              {
                tool: "tool_c",
                calledIn: 2,
                calledInFailed: 0,
                catalog: "inCatalog",
              },
            ],
            substitutions: [],
          },
        })}
        catalogState="loaded"
      />,
    );
    expect(screen.getByTestId("route-facts-section")).toHaveTextContent(
      "`tool_c` called in 2 of 3",
    );
  });

  it("names the variant when the row holds more than one", () => {
    render(
      <RouteFactsSection
        facts={facts()}
        catalogState="loaded"
        variantLabel="claude (anthropic)"
      />,
    );
    expect(screen.getByTestId("route-facts-variant")).toHaveTextContent(
      "claude (anthropic)",
    );
  });

  it("notes when the facts were computed on the page", () => {
    render(
      <RouteFactsSection facts={facts()} catalogState="loaded" computedHere />,
    );
    expect(screen.getByText("computed here")).toBeInTheDocument();
  });

  it("omits the mismatch expander for a negative test but keeps the route lines", () => {
    render(
      <RouteFactsSection
        facts={facts({ mismatch: { state: "excludedNegativeTest" } })}
        catalogState="loaded"
      />,
    );
    expect(screen.queryByText("Expected vs observed")).toBeNull();
    expect(screen.queryByText(/counted by tool name/)).toBeNull();
    const note = screen.getByTestId("route-facts-mismatch-note");
    expect(note).toHaveTextContent(
      "Negative test — mismatch facts are not measured.",
    );
    expect(note).toHaveTextContent("ended with a question: not measured");
    expect(screen.queryByText(/No gradeable trials/)).toBeNull();
  });

  it("says not measured, with no expander and no counting note, when there were no gradeable trials", () => {
    render(
      <RouteFactsSection
        facts={facts({ mismatch: { state: "notMeasured" } })}
        catalogState="loaded"
      />,
    );
    expect(screen.queryByText("Expected vs observed")).toBeNull();
    expect(screen.queryByText(/counted by tool name/)).toBeNull();
    expect(screen.queryByText(/Negative test/)).toBeNull();
    const note = screen.getByTestId("route-facts-mismatch-note");
    expect(note).toHaveTextContent("No gradeable trials — not measured.");
    expect(note).toHaveTextContent("ended with a question: not measured");
  });
});
