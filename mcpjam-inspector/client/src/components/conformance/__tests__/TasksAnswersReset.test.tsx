import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { TasksCheckOverride } from "../TasksCheckOverride";
import {
  tasksRunOptions,
  type ConformanceProbes,
} from "@/hooks/use-conformance-probes";

function Editor() {
  const [probes, setProbes] = useState<ConformanceProbes>({
    tasksProbe: { toolName: "finish" },
  });
  return (
    <>
      <TasksCheckOverride
        checkId="tasks-update-ack-shape"
        picked
        tools={{
          status: "ready",
          tools: ["finish", "ask"].map((name) => ({
            name,
            readOnly: true,
            destructive: false,
            hasOutputSchema: false,
          })),
        }}
        probes={probes}
        onChange={setProbes}
        onValidChange={() => {}}
      />
      <output>
        {JSON.stringify(
          tasksRunOptions(probes, { tasks: ["tasks-update-ack-shape"] }),
        )}
      </output>
    </>
  );
}
it("sends newly entered answers after resetting and reconfiguring the update override", async () => {
  const user = userEvent.setup();
  render(<Editor />);
  const inherit = screen.getByRole("checkbox", { name: "Use suite default" });
  await user.click(inherit);
  await user.click(screen.getByRole("combobox"));
  await user.click(screen.getByRole("option", { name: "ask · read-only" }));
  fireEvent.change(
    screen.getByRole("textbox", {
      name: "Answers to the task's questions (optional)",
    }),
    { target: { value: '{"name":"old"}' } },
  );
  await user.click(inherit);
  await user.click(inherit);
  await user.click(screen.getByRole("combobox"));
  await user.click(screen.getByRole("option", { name: "ask · read-only" }));
  const answers = screen.getByRole("textbox", {
    name: "Answers to the task's questions (optional)",
  });
  expect(answers).toHaveValue("");
  fireEvent.change(answers, { target: { value: '{"name":"new"}' } });
  expect(
    JSON.parse(screen.getByRole("status").textContent ?? "{}"),
  ).toMatchObject({
    inputResponses: { name: "new" },
    checkOverrides: { "tasks-update-ack-shape": { toolName: "ask" } },
  });
});
