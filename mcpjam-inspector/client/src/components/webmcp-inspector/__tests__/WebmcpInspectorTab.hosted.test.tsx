/**
 * The tab on a hosted replica: what it offers, and what it must not.
 *
 * `HOSTED_MODE` is a build constant read at module load, so this cannot share
 * a file with the local-mode viewport tests.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return { ...actual, HOSTED_MODE: true };
});

/** The panel needs a live computer and a minted token; neither exists here. */
vi.mock("@/components/computer/BrowserPanel", () => ({
  BrowserPanel: ({
    projectId,
    ensure,
  }: {
    projectId: string;
    ensure?: boolean;
  }) => (
    <div
      data-testid="browser-panel"
      data-project={projectId}
      data-ensure={String(ensure)}
    />
  ),
}));

const contextState = vi.hoisted(() => ({
  activeProjectId: "proj-1" as string | null,
}));
vi.mock("@/stores/client-context-store", () => ({
  useHostContextStore: (selector: (s: unknown) => unknown) =>
    selector(contextState),
}));

class FakeEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  close() {}
}
vi.stubGlobal("EventSource", FakeEventSource as never);

import { WebmcpInspectorTab } from "../WebmcpInspectorTab";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";

const HOSTED_SESSION = {
  sessionId: "hosted:proj-1:comp-1",
  status: "ready" as const,
  url: "https://shop.test/",
  createdAt: 0,
  expiresAt: 0,
  hardExpiresAt: 0,
  viewportTransport: { kind: "remote-interactive-url" as const, url: "" },
  protocolVersion: 1,
};

/** Spies for the actions the pane drives, so a poll is observable. */
let captureScreenshot: ReturnType<typeof vi.fn>;

function seed(session?: typeof HOSTED_SESSION) {
  captureScreenshot = vi.fn(async () => {});
  useWebmcpInspectorStore.setState({
    session,
    tools: [],
    activity: [],
    pending: [],
    starting: false,
    error: undefined,
    liveFrame: undefined,
    lastScreenshot: undefined,
    chatEnabled: false,
    captureScreenshot,
    setScreencast: vi.fn(async () => false),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  contextState.activeProjectId = "proj-1";
  seed(undefined);
});

describe("hosted WebMCP tab — the browser runs elsewhere", () => {
  it("offers no choice about WHERE the browser runs", () => {
    // A hosted replica has no display to open a window on and no `<webview>`
    // to attach to. The server refuses all three shapes, so a toggle would
    // offer an option that turns a working start into a 400.
    render(<WebmcpInspectorTab />);
    expect(screen.queryByText("On this machine")).toBeNull();
    expect(screen.queryByText("On my computer")).toBeNull();
    expect(screen.queryByText("In app")).toBeNull();
    expect(screen.queryByText("Chrome window")).toBeNull();
  });

  it("cannot start without a project, and says why", () => {
    contextState.activeProjectId = null;
    render(<WebmcpInspectorTab />);
    const button = screen.getByRole("button", { name: /open browser/i });
    expect(button).toBeDisabled();
    expect(
      screen.getByText(/needs a project to run under/i),
    ).toBeInTheDocument();
  });

  it("warns that the browser cannot reach the viewer's own network", () => {
    // The single most likely first thing someone tries is localhost, and it
    // will never work: the browser is in a datacenter.
    contextState.activeProjectId = null;
    render(<WebmcpInspectorTab />);
    expect(screen.getByText(/localhost/i)).toBeInTheDocument();
  });
});

describe("hosted WebMCP tab — the viewport is the panel", () => {
  beforeEach(() => {
    seed(HOSTED_SESSION);
  });

  it("embeds the live browser panel rather than pointing elsewhere", () => {
    render(<WebmcpInspectorTab />);
    const panel = screen.getByTestId("browser-panel");
    expect(panel).toBeInTheDocument();
    expect(panel.getAttribute("data-project")).toBe("proj-1");
  });

  it("never lets the viewport provision a machine", () => {
    // `ensure` would boot a browser from a VIEW. The session being watched
    // already reserved the computer; a viewport must not be able to.
    render(<WebmcpInspectorTab />);
    expect(
      screen.getByTestId("browser-panel").getAttribute("data-ensure"),
    ).toBe("false");
  });

  it("stops telling people to go and open a panel somewhere else", () => {
    // The old copy said "Open the Browser panel", which pointed at a route
    // that does not exist. The panel is right here now.
    render(<WebmcpInspectorTab />);
    expect(screen.queryByText(/Open the Browser panel/i)).toBeNull();
  });

  it("does not poll screenshots when a live stream is on screen", () => {
    render(<WebmcpInspectorTab />);
    expect(captureScreenshot).not.toHaveBeenCalled();
  });
});
