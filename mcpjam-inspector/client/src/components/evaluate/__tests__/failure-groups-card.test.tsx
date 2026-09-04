import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FailureGroupsCard } from "../failure-groups-card";
import type { SuiteFailureGroupsRow } from "../failure-groups-model";

const flagEnabled = vi.hoisted(() => ({ current: false }));
const queryCalls = vi.hoisted(() => ({
  current: [] as Array<{ name: unknown; args: unknown }>,
}));
const queryResult = vi.hoisted(() => ({
  current: undefined as unknown,
}));
const requestMut = vi.hoisted(() => ({
  current: vi.fn(async () => undefined),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "evaluate-failure-groups-enabled" ? flagEnabled.current : false,
}));

vi.mock("convex/react", () => ({
  useQuery: (name: unknown, args: unknown) => {
    queryCalls.current.push({ name, args });
    return queryResult.current;
  },
  useMutation: () => requestMut.current,
}));

afterEach(() => {
  cleanup();
  flagEnabled.current = false;
  queryCalls.current = [];
  queryResult.current = undefined;
  requestMut.current = vi.fn(async () => undefined);
});

function groupedRow(): SuiteFailureGroupsRow {
  return {
    suiteId: "suite_1",
    status: "completed",
    failedTrials: 14,
    judgedFailedTrials: 14,
    unjudgedFailedTrials: 0,
    grouped: true,
    k: 3,
    novelty: "measured",
    groups: [
      { index: 0, label: "Skipped the lookup", memberCount: 8 },
      { index: 1, label: "Called a sibling", memberCount: 5 },
      { index: 2, label: "Looped on search", memberCount: 1 },
    ],
    members: [
      {
        runId: "run_1",
        gradingKey: "a#1",
        caseKey: "case_a",
        caseTitle: "Look up a user",
        pathKey: "search→get",
        groupIndex: 0,
        novel: true,
      },
    ],
  };
}

describe("FailureGroupsCard", () => {
  it("issues no query and renders no DOM when the flag is off", () => {
    render(<FailureGroupsCard suiteId="suite_1" />);
    expect(screen.queryByTestId("failure-groups-card")).toBeNull();
    expect(queryCalls.current).toEqual([
      { name: "evalFailureGroups:getSuiteFailureGroups", args: "skip" },
    ]);
  });

  it("is collapsed by default and names the counts in the header", async () => {
    flagEnabled.current = true;
    queryResult.current = { latest: groupedRow(), inFlight: null };
    render(<FailureGroupsCard suiteId="suite_1" />);

    expect(queryCalls.current).toEqual([
      {
        name: "evalFailureGroups:getSuiteFailureGroups",
        args: { suiteId: "suite_1" },
      },
    ]);
    const card = screen.getByTestId("failure-groups-card");
    expect(card).toHaveTextContent("14 failed trials, 3 reasons");
    expect(card).toHaveTextContent("1 new");
    expect(screen.queryByLabelText(/Failed trials from case/)).toBeNull();

    await userEvent.setup().click(
      screen.getByRole("button", { name: /14 failed trials/ }),
    );
    expect(
      screen.getByRole("group", {
        name: /Failed trials from case through route to reason/,
      }),
    ).toBeInTheDocument();
  });

  it("shows the flat list when reasons did not separate", async () => {
    flagEnabled.current = true;
    queryResult.current = {
      latest: {
        ...groupedRow(),
        grouped: false,
        k: 1,
        novelty: "notMeasured",
        groups: [],
        members: [
          {
            runId: "run_1",
            gradingKey: "a#1",
            caseKey: "case_a",
            caseTitle: "Look up a user",
            pathKey: "search",
          },
        ],
      },
      inFlight: null,
    };
    render(<FailureGroupsCard suiteId="suite_1" />);
    await userEvent.setup().click(
      screen.getByRole("button", { name: /failed trial/ }),
    );
    expect(
      screen.getByText(/reasons did not separate into groups — showing the list/),
    ).toBeInTheDocument();
    expect(screen.getByText("Not judged")).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: /Failed trials from case/ }),
    ).toBeNull();
  });

  it("disables Group failures while a request is queued", () => {
    flagEnabled.current = true;
    queryResult.current = {
      latest: { ...groupedRow(), status: "queued" },
      inFlight: { status: "queued" },
    };
    render(<FailureGroupsCard suiteId="suite_1" />);
    expect(
      screen.getByRole("button", { name: /Grouping/ }),
    ).toBeDisabled();
  });
});
