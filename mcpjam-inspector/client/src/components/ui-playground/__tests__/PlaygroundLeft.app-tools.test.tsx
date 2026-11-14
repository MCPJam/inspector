import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PlaygroundLeft } from "../PlaygroundLeft";
import { makeAppInstance } from "@/test/factories";
import { useAppToolsRegistry } from "@mcpjam/widget-react";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => vi.fn(),
  routePaths: { servers: "/servers" },
}));
vi.mock("@/components/logger-view", () => ({ LoggerView: () => null }));
const props = {
  tools: {},
  selectedToolName: null,
  fetchingTools: false,
  onRefresh: vi.fn(),
  onSelectTool: vi.fn(),
  formFields: [],
  onFieldChange: vi.fn(),
  onToggleField: vi.fn(),
  isExecuting: false,
  onExecute: vi.fn(),
  onSave: vi.fn(),
  savedRequests: [],
  highlightedRequestId: null,
  onLoadRequest: vi.fn(),
  onRenameRequest: vi.fn(),
  onDuplicateRequest: vi.fn(),
  onDeleteRequest: vi.fn(),
  showLogger: false,
  hasConnectedServer: false,
};
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
it("keeps app selection collapsed with zero servers, runs locally and retains the closed result", async () => {
  const instance = makeAppInstance();
  const call = vi
    .spyOn(instance.bridge, "callTool")
    .mockResolvedValue({ content: [{ type: "text", text: "moved to e4" }] });
  await useAppToolsRegistry.getState().registerInstance(instance);
  render(<PlaygroundLeft {...props} />);
  expect(screen.queryByText(/No server connected/)).toBeNull();
  fireEvent.click(screen.getByText("make_move"));
  expect(screen.getByText("From Chess (srv-1)")).toBeInTheDocument();
  expect(screen.queryByTestId("app-tools-section")).toBeNull();
  expect(
    screen.getByText(/calls this tool in the app now/),
  ).toBeInTheDocument();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: /^Run/ })),
  );
  expect(call).toHaveBeenCalledOnce();
  expect(props.onExecute).not.toHaveBeenCalled();
  expect(screen.getByText("moved to e4")).toBeInTheDocument();
  act(() =>
    useAppToolsRegistry.getState().unregisterInstance(instance.bridgeId),
  );
  expect(screen.getByText("This tool's app closed.")).toBeInTheDocument();
  expect(screen.getByText("moved to e4")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Run/ })).toBeDisabled();
});
it("switching tabs clears the app selection", async () => {
  await useAppToolsRegistry.getState().registerInstance(makeAppInstance());
  render(<PlaygroundLeft {...props} />);
  fireEvent.click(screen.getByText("make_move"));
  fireEvent.click(screen.getByText("Saved"));
  expect(screen.queryByText("From Chess (srv-1)")).toBeNull();
});
