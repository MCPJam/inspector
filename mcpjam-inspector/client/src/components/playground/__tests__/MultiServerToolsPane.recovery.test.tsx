import type { AggregatedToolsState } from "@/hooks/use-aggregated-tools";
import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MultiServerToolsPaneInner } from "../panes/MultiServerToolsPane";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";

const mocks = vi.hoisted(() => ({
  flat: [] as AggregatedToolsState["flat"],
  errorByServer: {} as AggregatedToolsState["errorByServer"],
  execute: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("@/hooks/use-aggregated-tools", () => ({
  useAggregatedTools: () => ({
    flat: mocks.flat,
    collidingNames: [],
    loadingByServer: {},
    errorByServer: mocks.errorByServer,
    refetch: mocks.refetch,
  }),
}));
vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({ servers: {} }),
}));
vi.mock("@/components/ui-playground/hooks/use-playground-state", () => ({
  usePlaygroundStateContext: () => ({ executeTool: mocks.execute }),
}));
vi.mock("@/components/auth-challenge/PlaygroundAuthChallengeCards", () => ({
  PlaygroundAuthChallengeCards: () => null,
}));
vi.mock("@/components/playground/use-builtin-tool-run", () => ({
  useBuiltinToolRun: () => ({ selected: null, clear: vi.fn() }),
}));
vi.mock("@/components/playground/use-browser-tool-run", () => ({
  useBrowserToolRun: () => ({ selected: null, clear: vi.fn() }),
}));
vi.mock("@/components/ui/tool-details-accordion", () => ({
  ToolDetailsAccordion: () => null,
}));
vi.mock("@/components/ui-playground/ParametersForm", () => ({
  ParametersForm: () => null,
}));

beforeEach(() => {
  useUIPlaygroundStore.getState().reset();
  mocks.flat = [];
  mocks.errorByServer = {};
  mocks.execute.mockReset();
  mocks.refetch.mockReset();
});

it("identifies a server whose tool listing failed and lets the user refresh", () => {
  mocks.errorByServer = { bench: "Upstream failure" };
  const { rerender } = render(
    <MultiServerToolsPaneInner activeServerNames={["bench"]} />,
  );

  expect(screen.getByRole("status")).toHaveTextContent(
    "Couldn't load tools from bench. Use Refresh tools to try again.",
  );
  fireEvent.click(screen.getByTitle("Refresh tools"));
  expect(mocks.refetch).toHaveBeenCalledOnce();

  mocks.errorByServer = {};
  mocks.flat = [
    {
      serverId: "bench",
      toolName: "echo",
      tool: { name: "echo", inputSchema: { type: "object" } },
    },
  ];
  rerender(<MultiServerToolsPaneInner activeServerNames={["bench"]} />);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("button", { name: /^echo\b/ })).toBeInTheDocument();
});

it("lets Enter activate Reconnect when a working tool is still selected", async () => {
  const user = userEvent.setup();
  const reconnect = vi.fn();
  mocks.flat = [
    {
      serverId: "bench",
      toolName: "echo",
      tool: { name: "echo", inputSchema: { type: "object" } },
    },
  ];
  render(
    <MultiServerToolsPaneInner
      activeServerNames={["bench"]}
      serverConnectionControl={
        <button type="button" onClick={reconnect}>
          Reconnect a server
        </button>
      }
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^echo\b/ }));
  fireEvent.click(screen.getByRole("button", { name: "echo", exact: true }));
  expect(screen.getByRole("button", { name: "Run", exact: true })).toBeEnabled();

  screen.getByRole("button", { name: "Reconnect a server" }).focus();
  await user.keyboard("{Enter}");
  expect(reconnect).toHaveBeenCalledOnce();
  expect(mocks.execute).not.toHaveBeenCalled();
});

it("restores the exact server and inputs when its tools arrive, retaining them after refresh", () => {
  const servers = ["other", "bench"];
  const view = render(
    <MultiServerToolsPaneInner activeServerNames={servers} />,
  );
  act(() =>
    useUIPlaygroundStore.setState({
      recoveredToolCall: {
        serverName: "bench",
        toolName: "write",
        parameters: { value: "saved" },
      },
    }),
  );
  const entry = (serverId: string): AggregatedToolsState["flat"][number] => ({
    serverId,
    toolName: "write",
    tool: {
      name: "write",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    },
  });
  mocks.flat = [entry("other")];
  view.rerender(<MultiServerToolsPaneInner activeServerNames={servers} />);
  expect(
    screen.getByRole("button", { name: "Run", exact: true }),
  ).toBeDisabled();
  mocks.flat = [entry("other"), entry("bench")];
  view.rerender(<MultiServerToolsPaneInner activeServerNames={servers} />);
  expect(
    screen.getByRole("button", { name: "Run", exact: true }),
  ).toBeEnabled();
  expect(useUIPlaygroundStore.getState().recoveredToolCall).toBeNull();
  mocks.flat = [entry("bench"), entry("other")];
  view.rerender(<MultiServerToolsPaneInner activeServerNames={servers} />);
  fireEvent.click(screen.getByTitle("Refresh tools"));
  expect(
    screen.getByRole("button", { name: "Run", exact: true }),
  ).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Run", exact: true }));
  expect(mocks.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      serverName: "bench",
      toolName: "write",
      formFields: expect.arrayContaining([
        expect.objectContaining({ name: "value", value: "saved" }),
      ]),
    }),
  );
});

it("discards recovered inputs when their server is disabled", () => {
  useUIPlaygroundStore.setState({
    recoveredToolCall: {
      serverName: "bench",
      toolName: "write",
      parameters: { value: "old" },
    },
  });
  const view = render(<MultiServerToolsPaneInner activeServerNames={[]} />);
  expect(useUIPlaygroundStore.getState().recoveredToolCall).toBeNull();
  view.rerender(<MultiServerToolsPaneInner activeServerNames={["bench"]} />);
  expect(useUIPlaygroundStore.getState().recoveredToolCall).toBeNull();
});
