import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

const { mockSetSuiteSchedule, mockUseProjectEnvironments } = vi.hoisted(() => ({
  mockSetSuiteSchedule: vi.fn(async () => ({})),
  mockUseProjectEnvironments: vi.fn(() => [
    { environmentId: "env-a", name: "Alpha" },
    { environmentId: "env-b", name: "Beta" },
  ]),
}));

vi.mock("convex/react", () => ({
  useMutation: () => mockSetSuiteSchedule,
}));

vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: (projectId: string | null) =>
    projectId ? mockUseProjectEnvironments() : undefined,
}));

// The environment pin is flag-gated; these cases exercise the enabled path.
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ScheduleEditor } from "../schedule-editor";

describe("ScheduleEditor environment pin", () => {
  beforeEach(() => {
    mockSetSuiteSchedule.mockClear();
  });

  it("renders a required environment select for a multi-env suite and pins on enable", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleEditor
        suiteId="suite-1"
        schedule={undefined}
        projectId="proj-1"
        environmentIds={["env-b", "env-a"]}
      />
    );

    expect(
      screen.getByText("Scheduled runs use environment")
    ).toBeInTheDocument();

    await user.click(screen.getByRole("switch"));

    expect(mockSetSuiteSchedule).toHaveBeenCalledTimes(1);
    expect(mockSetSuiteSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        suiteId: "suite-1",
        enabled: true,
        // Defaults to the FIRST attached env (suite attach order), not the
        // environments list order.
        environmentId: "env-b",
      })
    );
  });

  it("uses the persisted pin over the attach-order default", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleEditor
        suiteId="suite-1"
        schedule={{
          intervalMinutes: 60,
          enabled: false,
          state: "active",
          environmentId: "env-a",
        }}
        projectId="proj-1"
        environmentIds={["env-b", "env-a"]}
      />
    );

    await user.click(screen.getByRole("switch"));

    expect(mockSetSuiteSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, environmentId: "env-a" })
    );
  });

  it("omits the pin (and the select) for single-env and legacy suites", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleEditor
        suiteId="suite-1"
        schedule={undefined}
        projectId="proj-1"
        environmentIds={["env-a"]}
      />
    );

    expect(
      screen.queryByText("Scheduled runs use environment")
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("switch"));

    expect(mockSetSuiteSchedule).toHaveBeenCalledTimes(1);
    const args = mockSetSuiteSchedule.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(args).not.toHaveProperty("environmentId");
  });
});
