import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useAppToolsRegistry } from "@mcpjam/widget-react";
import { makeAppInstance } from "@/test/factories";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import { MultiServerToolsPaneInner } from "../panes/MultiServerToolsPane";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  builtinRun: vi.fn(),
  browserRun: vi.fn(),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/components/ui-playground/hooks/use-playground-state", () => ({
  usePlaygroundStateContext: () => ({
    executeTool: mocks.execute,
    isExecuting: false,
  }),
}));
vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({ servers: {} }),
}));
vi.mock("@/hooks/use-aggregated-tools", () => ({
  useAggregatedTools: () => ({
    flat: [
      {
        serverId: "server",
        toolName: "server_tool",
        tool: { name: "server_tool", inputSchema: { type: "object" } },
      },
    ],
    collidingNames: [],
    loadingByServer: {},
    refetch: vi.fn(),
  }),
}));
vi.mock("../use-builtin-tool-run", async () => {
  const { useState } = await import("react");
  return {
    useBuiltinToolRun: () => {
      const [selectedKey, select] = useState<string | null>(null);
      return {
        selectedKey,
        select,
        clear: () => select(null),
        selected: selectedKey
          ? { key: selectedKey, name: "builtin_tool" }
          : null,
        fields: [],
        askAgentToRun: mocks.builtinRun,
      };
    },
  };
});
vi.mock("../use-browser-tool-run", async () => {
  const { useState } = await import("react");
  return {
    useBrowserToolRun: () => {
      const [selectedKey, select] = useState<string | null>(null);
      return {
        selectedKey,
        select,
        clear: () => select(null),
        selected: selectedKey
          ? { key: selectedKey, title: "page_tool", kind: "page" }
          : null,
        fields: [],
        catalog: [],
        run: mocks.browserRun,
        canRun: true,
        invoking: false,
      };
    },
  };
});
vi.mock("../BrowserToolsSection", () => ({
  BrowserToolsSection: ({ onSelect }: { onSelect: (key: string) => void }) => (
    <button onClick={() => onSelect("page")}>page row</button>
  ),
}));
vi.mock("../HarnessBuiltinToolsSection", () => ({
  HarnessBuiltinToolsSection: ({
    onSelect,
  }: {
    onSelect: (key: string) => void;
  }) => <button onClick={() => onSelect("builtin")}>builtin row</button>,
}));
vi.mock("../BuiltinToolDetailView", () => ({
  BuiltinToolDetailView: ({
    tool,
    onExpand,
  }: {
    tool: { name: string };
    onExpand: () => void;
  }) => (
    <div data-testid="detail">
      {tool.name}
      <button onClick={onExpand}>Back</button>
    </div>
  ),
}));
vi.mock("@/components/ui-playground/TabHeader", () => ({
  TabHeader: ({
    onExecute,
    canExecute,
    onTabChange,
  }: {
    onExecute: () => void;
    canExecute: boolean;
    onTabChange: (tab: "tools") => void;
  }) => (
    <>
      <button onClick={onExecute} disabled={!canExecute}>
        Run
      </button>
      <button onClick={() => onTabChange("tools")}>Tools tab</button>
    </>
  ),
}));
vi.mock("@/components/ui/tool-details-accordion", () => ({
  ToolDetailsAccordion: () => <div>Server details</div>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  useActiveChatSessionStore.setState({
    sessionId: "chat-1",
    compareActive: false,
    viewOnly: false,
  });
  useAppToolsRegistry.setState({
    enabled: true,
    aliases: new Map(),
    instancesByBridgeId: new Map(),
    activeBridgeByParent: new Map(),
    pendingControllers: new Map(),
  });
});
it("keeps four selections exclusive and routes Run and Enter to the selected source", async () => {
  const instance = makeAppInstance();
  const call = vi
    .spyOn(instance.bridge, "callTool")
    .mockResolvedValue({ content: [] });
  await useAppToolsRegistry.getState().registerInstance(instance);
  render(
    <MultiServerToolsPaneInner
      activeServerNames={["server"]}
      builtinTools={[]}
      browserTools={{
        attached: true,
        engine: "local",
        tools: [],
        page: null,
        refreshPage: vi.fn(),
        invokePage: vi.fn(),
      }}
    />,
  );
  fireEvent.click(screen.getByText("make_move"));
  expect(screen.getByTestId("detail")).toHaveTextContent("make_move");
  await act(async () => fireEvent.click(screen.getByText("Run")));
  expect(call).toHaveBeenCalledOnce();
  await act(async () =>
    fireEvent.keyDown(screen.getByTestId("detail"), { key: "Enter" }),
  );
  expect(call).toHaveBeenCalledTimes(2);
  act(() => useActiveChatSessionStore.setState({ viewOnly: true }));
  fireEvent.keyDown(screen.getByTestId("detail"), { key: "Enter" });
  expect(call).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByText("Tools tab"));
  expect(screen.queryByTestId("detail")).toBeNull();
  fireEvent.click(screen.getByText("builtin row"));
  expect(screen.getByTestId("detail")).toHaveTextContent("builtin_tool");
  fireEvent.click(screen.getByText("Run"));
  expect(mocks.builtinRun).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText("Back"));
  fireEvent.click(screen.getByText("page row"));
  expect(screen.getByTestId("detail")).toHaveTextContent("page_tool");
  fireEvent.click(screen.getByText("Run"));
  expect(mocks.browserRun).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText("Back"));
  fireEvent.click(screen.getByText("server_tool"));
  fireEvent.click(screen.getByText("Run"));
  expect(mocks.execute).toHaveBeenCalledOnce();
  expect(screen.queryByTestId("detail")).toBeNull();
});
