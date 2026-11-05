import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { SuiteRunBackButton } from "../suite-run-back-button";
import {
  readBackTarget,
  useEvaluateNavNavigate,
} from "../use-evaluate-nav-navigate";

const RUN_URL = "/evaluate/suite/s_1/runs/r_1";

function Where() {
  const location = useLocation();
  return (
    <p data-testid="where">
      {location.pathname} {JSON.stringify(location.state)}
    </p>
  );
}

function renderAt(state?: unknown, pathname = RUN_URL) {
  return render(
    <MemoryRouter initialEntries={[{ pathname, state }]}>
      <SuiteRunBackButton suiteId="s_1" />
      <OpenRunLink />
      <Where />
    </MemoryRouter>,
  );
}

/** A Runs-tab row: opens the suite run and names Runs as Back's target. */
function OpenRunLink() {
  const navigate = useEvaluateNavNavigate();
  return (
    <button
      type="button"
      onClick={() =>
        navigate({ type: "run-detail", suiteId: "s_1", runId: "r_1" }, "link", {
          backPlace: "runs",
        })
      }
    >
      Open run
    </button>
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
    const user = userEvent.setup();
    renderAt(undefined, "/evaluate/runs");
    await user.click(screen.getByRole("button", { name: "Open run" }));
    expect(screen.getByTestId("where")).toHaveTextContent(RUN_URL);
    const back = screen.getByRole("button", { name: "Back to runs" });
    await user.click(back);
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
