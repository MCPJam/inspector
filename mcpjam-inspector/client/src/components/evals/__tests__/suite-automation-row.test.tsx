/**
 * The schedule row, read as an automation.
 *
 * Three properties are worth pinning, and each one is a thing the old row got
 * wrong rather than a rendering detail:
 *
 *   - a PAUSED schedule keeps `enabled: true`, so "on" is not the state. The
 *     row has to lead with what the schedule is doing.
 *   - a schedule spends A PERSON'S access, and an owner who left has to read
 *     as somebody rather than as a bare id — that absence is the reason the
 *     schedule stopped.
 *   - an `inconclusive` run is NEVER red. It is a run the suite could not
 *     measure well enough to decide, and painting it as a failure blames the
 *     server for the grader.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EvalSuiteRun } from "../types";

const mocks = vi.hoisted(() => ({
  setSuiteSchedule: vi.fn(),
  reassignScheduleOwner: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: (name: string) =>
    name === "testSuites:reassignScheduleOwner"
      ? mocks.reassignScheduleOwner
      : mocks.setSuiteSchedule,
  useQuery: () => undefined,
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

// The editor is exercised by its own tests; here it only needs to appear.
vi.mock("../schedule-editor", async () => {
  const actual =
    await vi.importActual<typeof import("../schedule-editor")>(
      "../schedule-editor",
    );
  return {
    ...actual,
    ScheduleEditor: () => <div data-testid="schedule-editor" />,
  };
});

import { formatNextDue, SuiteAutomationRow } from "../suite-automation-row";

const OWNER = new Map([["user-1", { name: "Ada" }]]);

function run(
  id: string,
  result: EvalSuiteRun["result"],
  source: EvalSuiteRun["source"] = "schedule",
): EvalSuiteRun {
  return {
    _id: id,
    testSuiteId: "suite-1",
    createdBy: "user-1",
    status: "completed",
    result,
    source,
    createdAt: 1,
  } as unknown as EvalSuiteRun;
}

function renderRow(
  overrides: Partial<React.ComponentProps<typeof SuiteAutomationRow>> = {},
) {
  return render(
    <SuiteAutomationRow
      suiteId="suite-1"
      schedule={{
        intervalMinutes: 60,
        enabled: true,
        state: "active",
        createdByUserId: "user-1",
      }}
      runs={[]}
      userMap={OWNER}
      {...overrides}
    />,
  );
}

describe("SuiteAutomationRow", () => {
  it("names the person the schedule runs as", () => {
    renderRow();
    expect(
      screen.getByText(/Runs as Ada · pauses if they leave the organization/),
    ).toBeTruthy();
  });

  it("renders an owner who has left as a person, not an id", () => {
    renderRow({ userMap: new Map() });
    // The bare id would hide the whole point: this schedule no longer has
    // anybody's access to spend, which is why it stopped.
    expect(screen.getByText(/Runs as a former member/)).toBeTruthy();
    expect(screen.queryByText(/user-1/)).toBeNull();
  });

  it.each([
    ["paused_quota", /eval iteration quota was exhausted/],
    ["paused_auth", /could no longer authenticate/],
    ["paused_failures", /repeated consecutive failures/],
  ] as const)("says why it paused for %s", (state, copy) => {
    renderRow({
      schedule: {
        intervalMinutes: 60,
        // STILL enabled. That is exactly why "on" cannot be the state: a
        // reader who saw only the switch would report a healthy automation.
        enabled: true,
        state,
        createdByUserId: "user-1",
      },
    });
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText(copy)).toBeTruthy();
  });

  it("offers Resume when the schedule is off", async () => {
    const user = userEvent.setup();
    mocks.setSuiteSchedule.mockResolvedValue(undefined);
    renderRow({
      schedule: {
        intervalMinutes: 30,
        enabled: false,
        state: "active",
        createdByUserId: "user-1",
      },
    });
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(mocks.setSuiteSchedule).toHaveBeenCalledWith({
      suiteId: "suite-1",
      enabled: true,
      intervalMinutes: 30,
    });
  });

  it("offers Take over only for a lost-authorization pause", async () => {
    const user = userEvent.setup();
    mocks.reassignScheduleOwner.mockResolvedValue(undefined);
    const { unmount } = renderRow({
      schedule: {
        intervalMinutes: 60,
        enabled: true,
        state: "paused_failures",
        createdByUserId: "user-1",
      },
    });
    // A failure pause is fixed by fixing the failures, not by re-minting the
    // delegation — and the backend refuses to resume from anything else.
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    unmount();

    renderRow({
      schedule: {
        intervalMinutes: 60,
        enabled: true,
        state: "paused_auth",
        createdByUserId: "user-1",
      },
    });
    await user.click(screen.getByRole("button", { name: "Take over" }));
    expect(mocks.reassignScheduleOwner).toHaveBeenCalledWith({
      suiteId: "suite-1",
    });
  });

  it("hides Take over when the caller may not change the schedule", () => {
    renderRow({
      canTakeOver: false,
      schedule: {
        intervalMinutes: 60,
        enabled: true,
        state: "paused_auth",
        createdByUserId: "user-1",
      },
    });
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("shows only scheduled runs, and never paints an inconclusive one red", () => {
    const { container } = renderRow({
      runs: [
        run("r1", "passed"),
        run("r2", "inconclusive"),
        run("r3", "failed"),
        run("r4", "cancelled"),
        run("r5", "timed_out"),
        run("r6", "passed", "ui"),
      ],
    });
    const dots = Array.from(
      container.querySelectorAll("[data-run-result]"),
    ) as HTMLElement[];
    // The UI-launched run is not this row's business.
    expect(dots.map((d) => d.getAttribute("data-run-result"))).toEqual([
      "passed",
      "inconclusive",
      "failed",
      "cancelled",
      "timed_out",
    ]);
    const red = dots.filter((d) => d.className.includes("bg-destructive"));
    // Exactly one: the failure. An inconclusive run is not a defect anybody
    // observed, and neither is a cancellation or a timeout.
    expect(red).toHaveLength(1);
    expect(red[0].getAttribute("data-run-result")).toBe("failed");
  });

  it("opens the unchanged editor from Manage", async () => {
    const user = userEvent.setup();
    renderRow();
    expect(screen.queryByTestId("schedule-editor")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(await screen.findByTestId("schedule-editor")).toBeTruthy();
  });
});

describe("formatNextDue", () => {
  it("reads forward, and says nothing it does not know", () => {
    const now = 1_000_000;
    expect(formatNextDue(undefined, now)).toBe("—");
    expect(formatNextDue(now - 1, now)).toBe("due now");
    expect(formatNextDue(now + 4 * 60_000, now)).toBe("in 4m");
    expect(formatNextDue(now + 3 * 3_600_000, now)).toBe("in 3h");
    expect(formatNextDue(now + 48 * 3_600_000, now)).toBe("in 2d");
  });
});
