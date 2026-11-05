import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import {
  SuiteRunBackButton,
  evalNavBackState,
  readBackTarget,
} from "../suite-run-back-button";

const RUN_URL = "/evaluate/suite/s_1/runs/r_1";

function Where() {
  const location = useLocation();
  return (
    <p data-testid="where">
      {location.pathname} {JSON.stringify(location.state)}
    </p>
  );
}

function renderAt(state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: RUN_URL, state }]}>
      <SuiteRunBackButton suiteId="s_1" />
      <Where />
    </MemoryRouter>,
  );
}

describe("SuiteRunBackButton", () => {
  it("returns to the suite on a direct load", async () => {
    renderAt();
    const back = screen.getByRole("button", { name: "Back to suite" });
    await userEvent.setup().click(back);
    expect(screen.getByTestId("where")).toHaveTextContent(
      '/evaluate/suite/s_1 {"evalNavArrival":"back"}',
    );
  });

  it("returns to the page the user came from", async () => {
    renderAt(evalNavBackState({ type: "evaluate-runs" }, "Runs"));
    const back = screen.getByRole("button", { name: "Back to Runs" });
    await userEvent.setup().click(back);
    expect(screen.getByTestId("where")).toHaveTextContent(
      '/evaluate/runs {"evalNavArrival":"back"}',
    );
  });

  it("ignores state that would leave the app", () => {
    renderAt({ evalNavBack: { path: "//example.com", place: "Elsewhere" } });
    expect(screen.getByRole("button", { name: "Back to suite" })).toBeTruthy();
  });
});

describe("readBackTarget", () => {
  it("reads only a well-formed target", () => {
    expect(readBackTarget(undefined)).toBeNull();
    expect(readBackTarget({ evalNavBack: { path: "/evaluate" } })).toBeNull();
    expect(
      readBackTarget({ evalNavBack: { path: "evaluate", place: "Evaluate" } }),
    ).toBeNull();
    expect(
      readBackTarget({ evalNavBack: { path: "/evaluate", place: "Evaluate" } }),
    ).toEqual({ path: "/evaluate", place: "Evaluate" });
  });
});
