/**
 * The export buttons are the surface's takeaway: whatever the session recorded
 * leaves as a file. A download that silently does nothing is the one failure
 * mode with no error to show for it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WebmcpInspectorTab } from "../WebmcpInspectorTab";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import type {
  WebMcpActivityEntry,
  WebMcpSessionPublic,
} from "@/shared/webmcp-inspector-protocol";

// jsdom implements neither, and the tab reconnects its stream on mount.
class FakeEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  close() {}
}
vi.stubGlobal("EventSource", FakeEventSource as never);
if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:unstubbed";
  URL.revokeObjectURL = () => {};
}

const SESSION: WebMcpSessionPublic = {
  sessionId: "426581af-6f6c-43cf-8d02-643e09b240b0",
  status: "ready",
  url: "https://shop.test/",
  createdAt: 1_000,
  expiresAt: 2_000,
  hardExpiresAt: 3_000,
  viewportTransport: { kind: "native-window" },
  protocolVersion: 1,
};

const ACTIVITY: WebMcpActivityEntry[] = [
  { id: "a0", ts: 1_000, kind: "session_started", url: "https://shop.test/" },
];

const clipboard = vi.hoisted(() => ({ copy: vi.fn(async () => true) }));
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: (text: string) => clipboard.copy(text),
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe("WebmcpInspectorTab — export", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    useWebmcpInspectorStore.setState({
      session: SESSION,
      tools: [],
      activity: ACTIVITY,
      pending: [],
      starting: false,
      error: undefined,
      lastScreenshot: undefined,
      chatEnabled: false,
    });
  });

  it("copies the viewport's own diagnostics, and only with a session", async () => {
    clipboard.copy.mockClear();
    const view = render(<WebmcpInspectorTab />);
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await Promise.resolve();

    const copied = JSON.parse(String(clipboard.copy.mock.calls[0]![0]));
    // The fields nobody can see on screen and everybody needs in a bug report:
    // which transport is carrying the pane, and how the picture is being
    // encoded.
    expect(copied).toMatchObject({
      sessionId: SESSION.sessionId,
      frameTransport: { rung: expect.any(String) },
    });
    expect(copied.frameStats).toBeDefined();

    // Nothing to describe without a session, so no button to press.
    view.unmount();
    useWebmcpInspectorStore.setState({ session: undefined });
    render(<WebmcpInspectorTab />);
    expect(
      screen.queryByRole("button", { name: "Copy diagnostics" }),
    ).toBeNull();
  });

  it("does not revoke the blob URL in the same task as the click", () => {
    vi.useFakeTimers();
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:fake");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(<WebmcpInspectorTab />);
    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    // Firefox begins the download on a later task; revoking in this one
    // invalidates the URL before it is read and the file never arrives.
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("names the downloaded file after the session and format", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });

    render(<WebmcpInspectorTab />);
    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    fireEvent.click(screen.getByRole("button", { name: "Export OTLP" }));

    expect(downloads).toEqual([
      "webmcp-session-426581af.json",
      "webmcp-session-426581af.otlp.json",
    ]);
  });

  it("still offers the export after the browser has closed", () => {
    // The timeline is most wanted once something has gone wrong, which is
    // exactly when the session is no longer live.
    useWebmcpInspectorStore.setState({ session: undefined });
    render(<WebmcpInspectorTab />);
    expect(
      screen.getByRole("button", { name: "Export JSON" }),
    ).toBeInTheDocument();
  });

  it("offers no export for a session with an empty timeline", () => {
    useWebmcpInspectorStore.setState({ activity: [] });
    render(<WebmcpInspectorTab />);
    expect(screen.queryByRole("button", { name: "Export JSON" })).toBeNull();
  });
});
