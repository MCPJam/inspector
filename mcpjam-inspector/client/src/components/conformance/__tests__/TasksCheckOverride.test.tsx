import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ConformanceProbes } from "@/hooks/use-conformance-probes";
import { TasksCheckOverride } from "../TasksCheckOverride";
vi.mock("../ConformanceProbeField", () => ({
  ConformanceProbeField: ({
    probe,
    onChange,
  }: {
    probe: { toolName: string };
    onChange: (probe: { toolName: string }) => void;
  }) => (
    <select
      aria-label="Override tool"
      value={probe.toolName}
      onChange={(event) => onChange({ toolName: event.target.value })}
    >
      <option value="default">default</option>
      <option value="other">other</option>
    </select>
  ),
  TaskAnswersField: () => <div>Input answers</div>,
}));
const tools = { tools: [], status: "ready" as const };
function Editor({
  checkId = "tasks-inline-result",
  picked = true,
  valid = vi.fn(),
}: {
  checkId?: string;
  picked?: boolean;
  valid?: (part: string, valid: boolean) => void;
}) {
  const [probes, setProbes] = useState<ConformanceProbes>({
    tasksProbe: { toolName: "default", arguments: { original: true } },
  });
  return (
    <>
      <TasksCheckOverride
        checkId={checkId}
        picked={picked}
        tools={tools}
        probes={probes}
        onChange={setProbes}
        onValidChange={valid}
      />
      <output>{JSON.stringify(probes)}</output>
    </>
  );
}
it("inherits, overrides independently, and resets to the suite default", () => {
  render(<Editor />);
  expect(
    screen.getByText("Using default and the suite arguments."),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("checkbox", { name: "Use suite default" }));
  fireEvent.change(screen.getByLabelText("Override tool"), {
    target: { value: "other" },
  });
  expect(JSON.parse(screen.getByRole("status").textContent ?? "{}")).toEqual({
    tasksProbe: { toolName: "default", arguments: { original: true } },
    tasksOverrides: { "tasks-inline-result": { toolName: "other" } },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Use suite default" }));
  expect(screen.queryByLabelText("Override tool")).toBeNull();
  expect(
    screen.getByText("Using default and the suite arguments."),
  ).toBeDefined();
});
it.each([
  "tasks-wire-resolvable",
  "tasks-declaration-hygiene",
  "tasks-invalid-task-id-rejected",
])("has no picker for %s", (checkId) => {
  render(<Editor checkId={checkId} />);
  expect(screen.queryByRole("checkbox")).toBeNull();
});
it("clears validity when the check is deselected and shows answers only for update", async () => {
  const valid = vi.fn();
  const view = render(
    <Editor checkId="tasks-update-ack-shape" valid={valid} />,
  );
  expect(screen.getByText("Input answers")).toBeDefined();
  view.rerender(
    <Editor checkId="tasks-update-ack-shape" picked={false} valid={valid} />,
  );
  await waitFor(() =>
    expect(valid).toHaveBeenCalledWith("tasks-update-ack-shape:answers", true),
  );
  expect(screen.queryByText("Input answers")).toBeNull();
});
