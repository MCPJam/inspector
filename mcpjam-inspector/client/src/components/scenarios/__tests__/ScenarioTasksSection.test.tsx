/**
 * The study's "what to try" list, edited after the fact.
 *
 * What this pins: `items` REPLACES the stored list (so a removal removes, and
 * an empty list clears), Save is offered only when something would actually
 * change, and the editor reseeds from what the server accepted rather than
 * from what was typed.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioSettings } from "@/hooks/useScenarios";
import type { ScenarioTaskItem } from "@/types/chatUi";

const { updateScenarioMock, toastErrorMock, toastSuccessMock } = vi.hoisted(
  () => ({
    updateScenarioMock: vi.fn(),
    toastErrorMock: vi.fn(),
    toastSuccessMock: vi.fn(),
  }),
);

vi.mock("@/hooks/useScenarios", () => ({
  useScenarioMutations: () => ({ updateScenario: updateScenarioMock }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: toastErrorMock, success: toastSuccessMock },
}));

import { ScenarioTasksSection } from "../ScenarioTasksSection";

function scenario(
  items?: ScenarioTaskItem[],
  scenarioId = "cbx_1",
): ScenarioSettings {
  return {
    scenarioId,
    projectId: "proj_1",
    name: "Scenario",
    ...(items === undefined
      ? {}
      : { chatUi: { surfaces: { tasks: { items } } } }),
  } as unknown as ScenarioSettings;
}

const save = () => screen.getByTestId("user-testing-tasks-save");
const title = (i: number) =>
  screen.getByTestId(`user-testing-settings-task-title-${i}`);

describe("ScenarioTasksSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateScenarioMock.mockResolvedValue(undefined);
  });

  it("opens on one empty row for a study with no tasks", () => {
    // A bare "Add a task" button would make an empty list look like a feature
    // that had not loaded.
    render(<ScenarioTasksSection scenario={scenario()} />);
    expect(title(0)).toHaveValue("");
    expect(save()).toBeDisabled();
  });

  it("seeds from the stored list", () => {
    render(
      <ScenarioTasksSection
        scenario={scenario([
          { id: "a", title: "Find unpaid invoices", hint: "Any customer" },
          { id: "b", title: "Draft a reminder" },
        ])}
      />,
    );
    expect(title(0)).toHaveValue("Find unpaid invoices");
    expect(
      screen.getByTestId("user-testing-settings-task-hint-0"),
    ).toHaveValue("Any customer");
    expect(title(1)).toHaveValue("Draft a reminder");
  });

  it("offers Save only when the persisted list would change", () => {
    render(
      <ScenarioTasksSection scenario={scenario([{ id: "a", title: "One" }])} />,
    );
    expect(save()).toBeDisabled();

    // Adding an empty row changes nothing that would persist...
    fireEvent.click(screen.getByTestId("user-testing-settings-task-add"));
    expect(save()).toBeDisabled();

    // ...typing into it does.
    fireEvent.change(title(1), { target: { value: "Two" } });
    expect(save()).not.toBeDisabled();
  });

  it("replaces the whole list, so a removal removes", async () => {
    render(
      <ScenarioTasksSection
        scenario={scenario([
          { id: "a", title: "One" },
          { id: "b", title: "Two" },
        ])}
      />,
    );

    fireEvent.click(screen.getByTestId("user-testing-settings-task-remove-0"));
    fireEvent.click(save());

    await waitFor(() => expect(updateScenarioMock).toHaveBeenCalledTimes(1));
    expect(updateScenarioMock).toHaveBeenCalledWith({
      scenarioId: "cbx_1",
      chatUi: { surfaces: { tasks: { items: [{ id: "b", title: "Two" }] } } },
    });
  });

  it("clears the study's tasks with an empty list", async () => {
    // Which is what hides the tester-side control — there is no separate
    // "disable tasks" switch.
    render(
      <ScenarioTasksSection scenario={scenario([{ id: "a", title: "One" }])} />,
    );

    fireEvent.click(screen.getByTestId("user-testing-settings-task-remove-0"));
    fireEvent.click(save());

    await waitFor(() => expect(updateScenarioMock).toHaveBeenCalled());
    expect(updateScenarioMock.mock.calls[0][0].chatUi.surfaces.tasks).toEqual({
      items: [],
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringMatching(/tasks cleared/i),
    );
  });

  it("reseeds from what was sent, not from what was typed", async () => {
    render(<ScenarioTasksSection scenario={scenario()} />);

    fireEvent.change(title(0), { target: { value: "  Padded  " } });
    fireEvent.click(save());

    await waitFor(() => expect(updateScenarioMock).toHaveBeenCalled());
    // Normalization trims, so leaving the raw text in the field would show
    // rows the study does not have.
    await waitFor(() => expect(title(0)).toHaveValue("Padded"));
    expect(updateScenarioMock.mock.calls[0][0].chatUi.surfaces.tasks).toEqual({
      items: [{ id: expect.any(String), title: "Padded" }],
    });
  });

  it("goes quiet once the server's own value arrives", async () => {
    // Save is derived from stored-vs-draft rather than from a "touched" flag,
    // so it stops offering itself when the subscription echoes the write —
    // never because the component assumed the write landed.
    const { rerender } = render(<ScenarioTasksSection scenario={scenario()} />);

    fireEvent.change(title(0), { target: { value: "Try search" } });
    fireEvent.click(save());

    await waitFor(() => expect(updateScenarioMock).toHaveBeenCalled());
    const sent: ScenarioTaskItem[] =
      updateScenarioMock.mock.calls[0][0].chatUi.surfaces.tasks.items;

    rerender(<ScenarioTasksSection scenario={scenario(sent)} />);

    await waitFor(() => expect(save()).toBeDisabled());
  });

  it("keeps the draft when the save fails, and says so", async () => {
    updateScenarioMock.mockRejectedValue(new Error("nope"));
    render(<ScenarioTasksSection scenario={scenario()} />);

    fireEvent.change(title(0), { target: { value: "Try search" } });
    fireEvent.click(save());

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    // The work is still on screen and still saveable — a failed write must not
    // read as a successful one.
    expect(title(0)).toHaveValue("Try search");
    expect(save()).not.toBeDisabled();
  });

  it("does not adopt a subscription echo over unsaved work", async () => {
    // `scenario` arrives through a reactive query. Reseeding on every push
    // would discard rows the user has typed but not saved.
    const { rerender } = render(
      <ScenarioTasksSection scenario={scenario([{ id: "a", title: "One" }])} />,
    );

    fireEvent.change(title(0), { target: { value: "Edited locally" } });
    rerender(
      <ScenarioTasksSection scenario={scenario([{ id: "a", title: "One" }])} />,
    );

    expect(title(0)).toHaveValue("Edited locally");
  });
});
