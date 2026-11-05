import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ConformanceProbes } from "@/hooks/use-conformance-probes";
import { TasksCheckOverride } from "../TasksCheckOverride";

/** A tool option: its name, then its safety badge. */
const toolOption = (name: string, tag: string) =>
  new RegExp(`^${name}\\s*·\\s*${tag}$`);

const tools = {
  status: "ready" as const,
  tools: ["default", "other"].map((name) => ({
    name,
    readOnly: true,
    destructive: false,
    hasOutputSchema: false,
  })),
};
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
        checkTitle="Inline Result"
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
const saved = () =>
  JSON.parse(screen.getByRole("status").textContent ?? "{}");
const toolField = () =>
  screen.getByRole("combobox", {
    name: "Tool that creates a task for Inline Result",
  });

it("shows the suite tool in its dropdown, overrides on a new pick, and resets with the box", async () => {
  const user = userEvent.setup();
  render(<Editor />);
  const inherit = screen.getByRole("checkbox", { name: "Use suite default" });
  expect(inherit).toBeChecked();
  expect(toolField()).toHaveTextContent("default");

  await user.click(toolField());
  await user.click(screen.getByRole("option", { name: toolOption("other", "read-only") }));
  expect(saved()).toEqual({
    tasksProbe: { toolName: "default", arguments: { original: true } },
    tasksOverrides: { "tasks-inline-result": { toolName: "other" } },
  });
  expect(inherit).not.toBeChecked();

  await user.click(inherit);
  expect(saved().tasksOverrides).toEqual({});
  expect(toolField()).toHaveTextContent("default");
});

it("keeps the suite tool and arguments as its own when the box is cleared", async () => {
  const user = userEvent.setup();
  render(<Editor />);
  await user.click(screen.getByRole("checkbox", { name: "Use suite default" }));
  expect(saved().tasksOverrides).toEqual({
    "tasks-inline-result": { toolName: "default", arguments: { original: true } },
  });
});

it("waits for a tool when Not set is picked on this check alone", async () => {
  const user = userEvent.setup();
  const valid = vi.fn();
  render(<Editor valid={valid} />);
  await user.click(toolField());
  await user.click(screen.getByRole("option", { name: "Not set" }));
  expect(saved().tasksOverrides).toEqual({
    "tasks-inline-result": { toolName: "" },
  });
  await waitFor(() =>
    expect(valid).toHaveBeenLastCalledWith("tasks-inline-result", false),
  );
});

it.each([
  "tasks-wire-resolvable",
  "tasks-declaration-hygiene",
  "tasks-invalid-task-id-rejected",
])("has no picker for %s", (checkId) => {
  render(<Editor checkId={checkId} />);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("clears validity when the check is deselected and shows answers only for update", async () => {
  const valid = vi.fn();
  const answers = "Answers to the task's questions (optional)";
  const view = render(
    <Editor checkId="tasks-update-ack-shape" valid={valid} />,
  );
  expect(screen.getByRole("textbox", { name: answers })).toBeDefined();
  view.rerender(
    <Editor checkId="tasks-update-ack-shape" picked={false} valid={valid} />,
  );
  await waitFor(() =>
    expect(valid).toHaveBeenCalledWith("tasks-update-ack-shape:answers", true),
  );
  expect(screen.queryByRole("textbox", { name: answers })).toBeNull();
});
