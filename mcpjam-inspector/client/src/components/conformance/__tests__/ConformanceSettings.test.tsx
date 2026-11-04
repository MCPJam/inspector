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
        hasOutputSchema: true,
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
}: {
  saved: boolean;
  onSave: ReturnType<typeof vi.fn>;
}) {
  const [value, setValue] = useState(initial);
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
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
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
