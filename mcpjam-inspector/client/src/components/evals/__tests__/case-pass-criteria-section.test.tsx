import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  isCasePassCriteriaOverridden,
  CasePassCriteriaPopover,
} from "../case-pass-criteria-section";

describe("isCasePassCriteriaOverridden", () => {
  it("returns false when match options and predicates inherit", () => {
    expect(isCasePassCriteriaOverridden(undefined, undefined)).toBe(false);
    expect(isCasePassCriteriaOverridden(undefined, { mode: "inherit" })).toBe(
      false,
    );
  });

  it("returns true when validators diverge from suite defaults", () => {
    expect(
      isCasePassCriteriaOverridden({ argumentMatching: "strict" }, undefined),
    ).toBe(true);
  });

  it("returns true when checks override suite defaults", () => {
    expect(
      isCasePassCriteriaOverridden(undefined, {
        mode: "override",
        predicates: [],
      }),
    ).toBe(true);
  });
});

describe("CasePassCriteriaPopover", () => {
  it("opens pass criteria content from the gear button", async () => {
    const user = userEvent.setup();

    render(
      <CasePassCriteriaPopover
        matchOptions={undefined}
        onMatchOptionsChange={() => {}}
        suiteDefaultMatchOptions={undefined}
        predicates={undefined}
        onPredicatesChange={() => {}}
        suiteDefaultPredicates={[]}
      />,
    );

    await user.click(screen.getByTestId("case-pass-criteria-toggle"));

    expect(screen.getByText("Pass criteria")).toBeInTheDocument();
    expect(screen.getByText("Validators")).toBeInTheDocument();
  });

  it("shows an override indicator when the case diverges from suite defaults", () => {
    render(
      <CasePassCriteriaPopover
        matchOptions={{ argumentMatching: "strict" }}
        onMatchOptionsChange={() => {}}
        suiteDefaultMatchOptions={undefined}
        predicates={undefined}
        onPredicatesChange={() => {}}
        suiteDefaultPredicates={[]}
      />,
    );

    expect(
      screen.getByTestId("case-pass-criteria-overridden-badge"),
    ).toBeInTheDocument();
  });
});
