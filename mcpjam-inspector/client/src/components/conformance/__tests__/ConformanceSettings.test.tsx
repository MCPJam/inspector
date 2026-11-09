import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createConnectedServer,
  createHttpServerConfig,
} from "@/test/factories";
import type { ConformanceDefaults } from "@/hooks/use-conformance-server-data";
import { ConformanceSettings } from "../ConformanceSettings";
import { SavedRunSettings } from "../ConformanceRunActions";
const toolsMock = vi.hoisted(() => ({ outputSchema: true }));
vi.mock("../ConformanceProbeField", async (original) => ({
  ...(await original<typeof import("../ConformanceProbeField")>()),
  useProbeTools: () => ({
    status: "ready",
    tools: [
      {
        name: "echo",
        readOnly: true,
        destructive: false,
        hasOutputSchema: false,
      },
      {
        name: "output",
        readOnly: true,
        destructive: false,
        hasOutputSchema: toolsMock.outputSchema,
      },
    ],
  }),
}));
const server = createConnectedServer({
  name: "alpha",
  config: createHttpServerConfig("https://example.com/mcp"),
});
const initial: ConformanceDefaults = {
  selection: {},
  inputs: {
    logProbe: { toolName: "echo", level: "info" },
    inputRequiredProbe: { toolName: "echo" },
    toolCallProbe: { toolName: "output" },
    tasksProbe: { toolName: "echo", inputResponses: { confirm: true } },
  },
};
function Harness({
  saved,
  onSave,
  selection = initial.selection,
}: {
  saved: boolean;
  onSave: ReturnType<typeof vi.fn>;
  selection?: ConformanceDefaults["selection"];
}) {
  const [value, setValue] = useState({ ...initial, selection });
  const save = async (
    selection: ConformanceDefaults["selection"],
    inputs: ConformanceDefaults["inputs"],
  ) => {
    await onSave(selection, inputs);
    setValue({
      selection,
      inputs: Object.fromEntries(Object.entries(inputs).reverse()),
    });
  };
  return saved ? (
    <SavedRunSettings
      serverName="alpha"
      onBack={vi.fn()}
      settings={{
        loaded: true,
        defaults: { alpha: value.selection },
        inputs: { alpha: value.inputs },
        servers: { alpha: server },
        save: (_name, selection, inputs) => save(selection, inputs ?? {}),
      }}
    />
  ) : (
    <ConformanceSettings
      serverName="alpha"
      server={server}
      defaults={value.selection}
      inputs={value.inputs}
      onSave={save}
      onBack={vi.fn()}
    />
  );
}
describe("Settings inputs", () => {
  it("keeps a saved output tool visible when no tool declares an output schema", async () => {
    toolsMock.outputSchema = false;
    try {
      const user = userEvent.setup();
      render(<Harness saved={false} onSave={vi.fn(async () => {})} />);
      // The saved tool is still called, so the user must see it to clear it.
      const field = screen.getByRole("combobox", {
        name: "Tool to check output",
      });
      // The server still lists it, so it is not shown as missing.
      expect(field).toHaveTextContent("output·read-only");
      expect(
        screen.getByText(
          "This tool no longer declares an output schema. It is still called, but its result cannot be checked. Pick another tool or clear it.",
        ),
      ).toBeInTheDocument();
      const box = screen.getByRole("checkbox", {
        name: "Run Tool Output Schema Honored",
      });
      expect(box.closest("label")!.parentElement).not.toHaveClass(
        "opacity-50",
      );
      await user.click(field);
      await user.click(screen.getByRole("option", { name: "Not set" }));
      // Cleared, the check has nothing to grade: shaded, no field.
      await waitFor(() =>
        expect(
          screen.queryByRole("combobox", { name: "Tool to check output" }),
        ).toBeNull(),
      );
      expect(box.closest("label")!.parentElement).toHaveClass("opacity-50");
    } finally {
      toolsMock.outputSchema = true;
    }
  });

  it.each([false, true])(
    "shows and saves every input in both Settings views (saved: %s)",
    async (saved) => {
      const user = userEvent.setup();
      const onSave = vi.fn(async () => {});
      render(<Harness saved={saved} onSave={onSave} />);
      for (const name of [
        "Tool that emits logs",
        "Tool that asks for input",
        "Tool to check output",
        "Tool that creates a task",
      ])
        expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
      await user.click(
        screen.getByRole("combobox", { name: "Log level to request" }),
      );
      await user.click(screen.getByRole("option", { name: "debug" }));
      await waitFor(() =>
        expect(onSave).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({
            logProbe: { toolName: "echo", level: "debug" },
          }),
        ),
      );
      const answers = screen.getByRole("textbox", {
        name: "Answers to the task's questions (optional)",
      });
      fireEvent.change(answers, { target: { value: "[1]" } });
      expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
      const calls = onSave.mock.calls.length;
      await act(async () => {});
      expect(onSave).toHaveBeenCalledTimes(calls);
      fireEvent.change(answers, { target: { value: '{"confirm":false}' } });
      await waitFor(() =>
        expect(onSave).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({
            tasksProbe: {
              toolName: "echo",
              inputResponses: { confirm: false },
            },
          }),
        ),
      );
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Back" })).toBeEnabled(),
      );
      await user.click(
        screen.getByRole("combobox", { name: "Tool that creates a task" }),
      );
      await user.click(screen.getByRole("option", { name: "Not set" }));
      await waitFor(() =>
        expect(onSave.mock.calls.at(-1)?.[1]).not.toHaveProperty("tasksProbe"),
      );
    },
  );
  it.each([false, true])(
    "blocks malformed arguments and saves special JSON keys (saved: %s)",
    async (saved) => {
      const onSave = vi.fn(async () => {});
      render(<Harness saved={saved} onSave={onSave} />);
      const field = screen
        .getByRole("combobox", { name: "Tool that emits logs" })
        .parentElement!.closest("div.space-y-2")!;
      fireEvent.click(within(field).getByRole("switch"));
      const args = within(field).getByRole("textbox", { name: "Arguments" });
      fireEvent.change(args, { target: { value: "[1]" } });
      expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
      expect(onSave).not.toHaveBeenCalled();
      fireEvent.change(args, {
        target: { value: '{"filter":{"$gt":5},"año":2026}' },
      });
      await waitFor(() =>
        expect(onSave).toHaveBeenLastCalledWith(
          {},
          expect.objectContaining({
            ...initial.inputs,
            logProbe: {
              toolName: "echo",
              level: "info",
              arguments: { filter: { $gt: 5 }, año: 2026 },
            },
          }),
        ),
      );
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Back" })).toBeEnabled(),
      );
      expect(screen.getByRole("textbox", { name: "Arguments" })).toBe(args);
    },
  );
  it("shows an off check's tool field while its row is open, without blocking on it", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        saved={false}
        onSave={vi.fn(async () => {})}
        selection={{ protocol: [], tasks: [] }}
      />,
    );
    const taskField = () =>
      screen.queryByRole("combobox", {
        name: "Tool that creates a task for Result Type Discipline",
      });
    const outputField = () =>
      screen.queryByRole("combobox", { name: "Tool to check output" });
    expect(taskField()).toBeNull();
    expect(outputField()).toBeNull();
    // The badge stays with the suite off.
    const taskRow = screen.getByRole("button", {
      name: /^Result Type Discipline/,
    });
    expect(within(taskRow).getByText("Input set")).toBeInTheDocument();

    await user.click(taskRow);
    expect(taskField()).toHaveTextContent("echo");
    await user.click(taskRow);
    expect(taskField()).toBeNull();

    await user.click(
      screen.getByRole("button", { name: /^Tool Output Schema Honored/ }),
    );
    const field = outputField()!.parentElement!.closest("div.space-y-2")!;
    fireEvent.click(within(field).getByRole("switch"));
    fireEvent.change(within(field).getByRole("textbox", { name: "Arguments" }), {
      target: { value: "[1]" },
    });
    // The check is off, so its tool is not called yet.
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    await user.click(
      screen.getByRole("checkbox", { name: "Run Tool Output Schema Honored" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Back" })).toBeDisabled(),
    );
  });

  it("updates untouched inputs from shared defaults", () => {
    const props = {
      serverName: "alpha",
      server,
      onSave: vi.fn(),
      onBack: vi.fn(),
    };
    const { rerender } = render(
      <ConformanceSettings {...props} inputs={initial.inputs} />,
    );
    rerender(
      <ConformanceSettings
        {...props}
        inputs={{
          ...initial.inputs,
          tasksProbe: { toolName: "echo", inputResponses: { confirm: false } },
        }}
      />,
    );
    expect(
      screen.getByRole("textbox", {
        name: "Answers to the task's questions (optional)",
      }),
    ).toHaveValue(JSON.stringify({ confirm: false }, null, 2));
  });
  it("retries a failed saved-server defaults read before opening the editor", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(initial);
    render(
      <SavedRunSettings
        serverName="alpha"
        onBack={vi.fn()}
        settings={{
          loaded: true,
          load,
          servers: { alpha: server },
          save: vi.fn(),
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading defaults");
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load your saved inputs. Try again.",
    );
    expect(
      screen.queryByRole("combobox", { name: "Tool that emits logs" }),
    ).toBeNull();
    fireEvent.click(retry);
    expect(
      await screen.findByRole("combobox", { name: "Tool that emits logs" }),
    ).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("offers connection and sign-in without changing the fixed server", async () => {
    const connect = vi
      .fn()
      .mockResolvedValueOnce("reauth")
      .mockResolvedValueOnce("ready");
    render(
      <ConformanceSettings
        serverName="alpha"
        server={{ ...server, connectionStatus: "disconnected" }}
        inputs={initial.inputs}
        onSave={vi.fn()}
        onBack={vi.fn()}
        onConnectServer={connect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(connect).toHaveBeenLastCalledWith("alpha", { signIn: true }),
    );
    expect(
      screen.getByRole("heading", { name: "alpha Conformance Settings" }),
    ).toBeInTheDocument();
  });
});
