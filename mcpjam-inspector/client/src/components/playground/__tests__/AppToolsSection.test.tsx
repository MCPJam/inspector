import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppToolsSection } from "../AppToolsSection";
import { makeAppInstance } from "@/test/factories";
import { useAppToolsRegistry } from "@mcpjam/widget-react";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";

beforeEach(() => {
  useActiveChatSessionStore.setState({
    sessionId: "chat-1",
    compareActive: false,
  });
  useAppToolsRegistry.setState({
    enabled: true,
    aliases: new Map(),
    instancesByBridgeId: new Map(),
    activeBridgeByParent: new Map(),
  });
});
async function register() {
  await useAppToolsRegistry
    .getState()
    .registerInstance(
      makeAppInstance({
        tools: [
          {
            name: "move",
            annotations: { readOnlyHint: true },
            inputSchema: { type: "object", description: "x".repeat(9000) },
          },
        ],
      }),
    );
}
describe("App tools section", () => {
  it("shows grouped tools, warning copy, read-only claim and selection", async () => {
    await register();
    const onSelect = vi.fn();
    render(<AppToolsSection searchQuery="" onSelect={onSelect} />);
    expect(screen.getByText("Chess")).toBeInTheDocument();
    expect(screen.getByText("srv-1")).toBeInTheDocument();
    expect(screen.getByText("app says read-only")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The model can't see this tool. Its input schema is over 8 KiB.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("move"));
    expect(onSelect).toHaveBeenCalledWith("app:chat-1\0call-1\0move");
  });
  it("hides empty, search misses and compare sessions", async () => {
    const props = { searchQuery: "", onSelect: vi.fn() };
    const { container, rerender } = render(<AppToolsSection {...props} />);
    expect(container).toBeEmptyDOMElement();
    await register();
    rerender(<AppToolsSection {...props} searchQuery="no match" />);
    expect(container).toBeEmptyDOMElement();
    useActiveChatSessionStore.setState({ compareActive: true });
    rerender(<AppToolsSection {...props} />);
    expect(container).toBeEmptyDOMElement();
  });
  it.each([
    ["claude-code", "Claude Code"],
    ["codex", "Codex"],
  ])(
    "explains %s and suppresses model availability warnings",
    async (id, name) => {
      await register();
      render(
        <AppToolsSection
          searchQuery=""
          onSelect={vi.fn()}
          previewedHarnessId={id}
        />,
      );
      expect(
        screen.getByText(
          `${name} can't call app tools. Run still calls them in the app.`,
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/The model can't see this tool/),
      ).not.toBeInTheDocument();
    },
  );
});
