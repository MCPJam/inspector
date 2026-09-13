import { beforeEach, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: mocks.fetch }));
import { AssertionBacktestPanel } from "../assertion-backtest-panel";
const assertions = [{ type: "responseContains" as const, needle: "hello" }];
beforeEach(() => mocks.fetch.mockReset());
it("previews only after an explicit action and displays partial coverage", async () => {
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      schemaVersion: 1,
      sourceRunId: "run",
      complete: false,
      counts: { iterations: 1, comparable: 0, ungradable: 1, flipped: 0 },
      differences: [
        {
          iterationId: "iteration",
          evaluatorId: "assertion",
          comparable: false,
          reason: "Missing tool inventory",
        },
      ],
    }),
  });
  render(
    <AssertionBacktestPanel
      projectId="project"
      runId="run"
      assertions={assertions}
    />,
  );
  expect(mocks.fetch).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Preview assertions" }),
  );
  expect(await screen.findByText(/Partial comparison/)).toBeTruthy();
  expect(screen.getByText(/Missing tool inventory/)).toBeTruthy();
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({
    assertions: { mode: "replace", list: assertions },
  });
});
it("clears stale results when the draft changes", async () => {
  mocks.fetch.mockResolvedValue({
    ok: false,
    json: async () => ({ message: "Wait one minute" }),
  });
  const { rerender } = render(
    <AssertionBacktestPanel
      projectId="project"
      runId="run"
      assertions={assertions}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Preview assertions" }),
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  rerender(
    <AssertionBacktestPanel
      projectId="project"
      runId="other"
      assertions={assertions}
    />,
  );
  expect(screen.queryByRole("alert")).toBeNull();
});
