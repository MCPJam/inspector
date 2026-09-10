import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { type ReactNode } from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";

import { WebmcpInspectorTab } from "../WebmcpInspectorTab";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import type { WebMcpSessionPublic } from "@/shared/webmcp-inspector-protocol";

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children?: ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

vi.mock("@/components/browser/ElectronNativeBody", () => ({
  ElectronNativeBody: ({ session }: { session: { bootId: string } }) => (
    <div data-testid="native-browser">{session.bootId}</div>
  ),
}));
class FakeEventSource {
  onmessage = null;
  onerror = null;
  close() {}
}
vi.stubGlobal("EventSource", FakeEventSource);
const session: WebMcpSessionPublic = {
  sessionId: "native-session",
  status: "ready",
  url: "https://shop.test/",
  createdAt: 1,
  expiresAt: 2,
  hardExpiresAt: 3,
  viewportTransport: { kind: "electron-native", bootId: "native-boot" },
  protocolVersion: 1,
};
beforeEach(() => {
  window.isElectron = true;
  useWebmcpInspectorStore.setState({
    session: undefined,
    tools: [],
    activity: [],
    pending: [],
    starting: false,
    error: undefined,
    liveFrame: undefined,
    lastScreenshot: undefined,
    chatEnabled: false,
    sendCommand: vi.fn(async () => ({ state: null })),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    setScreencast: vi.fn(async () => false),
    captureScreenshot: vi.fn(async () => {}),
  });
});
afterEach(() => {
  delete window.isElectron;
});
describe("main-owned browser surface", () => {
  it("starts without mounting a guest or sending a webContentsId", async () => {
    const startSession = vi.fn(async () => {
      useWebmcpInspectorStore.setState({ session });
      return session.sessionId;
    });
    useWebmcpInspectorStore.setState({ startSession });
    render(<WebmcpInspectorTab />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
    });
    expect(startSession).toHaveBeenCalled();
    expect(startSession.mock.calls[0]).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ webContentsId: expect.anything() }),
      ]),
    );
    expect(document.querySelector("webview")).toBeNull();
    expect(await screen.findByTestId("native-browser")).toHaveTextContent(
      "native-boot",
    );
    expect(screen.getByTestId("browser-address")).toBeInTheDocument();
    expect(screen.queryByText("Take control")).toBeNull();
  });
  it("hides the native view on unmount without closing its browser session", () => {
    const closeSession = vi.fn(async () => {});
    useWebmcpInspectorStore.setState({ session, closeSession });
    const mounted = render(<WebmcpInspectorTab />);
    mounted.unmount();
    expect(closeSession).not.toHaveBeenCalled();
  });
});
