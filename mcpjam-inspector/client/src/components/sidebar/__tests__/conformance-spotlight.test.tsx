import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectedServer, createServer } from "@/test/factories";
import type { AppState, ServerWithName } from "@/state/app-types";
import {
  CONFORMANCE_SPOTLIGHT_DELAY_MS,
  CONFORMANCE_SPOTLIGHT_STORAGE_KEY,
  ConformanceSpotlight,
  pickConformanceServer,
} from "../conformance-spotlight";

const { track, fixture } = vi.hoisted(() => ({
  track: vi.fn(),
  fixture: {
    isMobile: false,
    appState: null as Pick<AppState, "servers" | "selectedServer"> | null,
  },
}));
vi.mock("@/lib/analytics", () => ({ track }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => fixture.isMobile }));
vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () => fixture.appState,
}));

const onNavigate = vi.fn();
const TITLE = "Check your server against the MCP spec";

function renderSpotlight(
  onConformancePage = false,
  servers?: Record<string, ServerWithName>,
) {
  return render(
    <ConformanceSpotlight
      enabled
      servers={servers}
      onConformancePage={onConformancePage}
      onNavigate={onNavigate}
    >
      <button type="button">Conformance</button>
    </ConformanceSpotlight>,
  );
}

function withServers(...servers: ReturnType<typeof createServer>[]) {
  fixture.appState = {
    servers: Object.fromEntries(servers.map((s) => [s.name, s])),
    selectedServer: "none",
  };
}

async function waitForOpen() {
  await act(async () => {
    vi.advanceTimersByTime(CONFORMANCE_SPOTLIGHT_DELAY_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  fixture.isMobile = false;
  fixture.appState = null;
  onNavigate.mockClear();
  track.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("pickConformanceServer", () => {
  it("prefers the selected server, then a connected one, then any", () => {
    const idle = createServer({ name: "idle" });
    const live = createConnectedServer({ name: "live" });
    const servers = { idle, live };
    expect(pickConformanceServer(servers, "idle")).toBe("idle");
    expect(pickConformanceServer(servers, "none")).toBe("live");
    expect(pickConformanceServer({ idle }, undefined)).toBe("idle");
    expect(pickConformanceServer({}, "none")).toBe(null);
  });
});

describe("ConformanceSpotlight", () => {
  it("defers without marking dismissed while announcements are disabled", async () => {
    const spotlight = (enabled: boolean) => (
      <ConformanceSpotlight
        enabled={enabled}
        onConformancePage={false}
        onNavigate={onNavigate}
      >
        <button type="button">Conformance</button>
      </ConformanceSpotlight>
    );
    const { rerender } = render(spotlight(false));
    await waitForOpen();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorage.getItem(CONFORMANCE_SPOTLIGHT_STORAGE_KEY)).toBeNull();
    expect(track).not.toHaveBeenCalled();

    rerender(spotlight(true));
    await waitForOpen();
    expect(screen.getByRole("dialog", { name: TITLE })).toBeVisible();

    rerender(spotlight(false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorage.getItem(CONFORMANCE_SPOTLIGHT_STORAGE_KEY)).toBeNull();
  });

  it("opens after a delay without taking focus and lists the suites", async () => {
    renderSpotlight();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitForOpen();
    expect(screen.getByRole("dialog", { name: TITLE })).toBeVisible();
    expect(
      screen.getByText(/the spec's Protocol, Apps, Tasks and OAuth checks/),
    ).toBeVisible();
    expect(document.activeElement).toBe(document.body);
    expect(track).toHaveBeenCalledWith(
      "feature_spotlight_engagement",
      expect.objectContaining({ action: "shown", has_server: false }),
    );
  });

  it("starts a run for the user's server from the primary action", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    withServers(createConnectedServer({ name: "excalidraw" }));
    renderSpotlight();
    await waitForOpen();
    await user.click(screen.getByRole("button", { name: "Check excalidraw" }));
    expect(onNavigate).toHaveBeenCalledWith("/conformance?run=excalidraw");
    expect(localStorage.getItem(CONFORMANCE_SPOTLIGHT_STORAGE_KEY)).toBe(
      "dismissed",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers a saved server that has no runtime connection yet", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    withServers();
    renderSpotlight(false, { saved: createServer({ name: "saved" }) });
    await waitForOpen();
    await user.click(screen.getByRole("button", { name: "Check saved" }));
    expect(onNavigate).toHaveBeenCalledWith("/conformance?run=saved");
  });

  it("opens Conformance when there is no server to check", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSpotlight();
    await waitForOpen();
    await user.click(screen.getByRole("button", { name: "Open Conformance" }));
    expect(onNavigate).toHaveBeenCalledWith("/conformance");
  });

  it.each([
    [
      "Got it",
      (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole("button", { name: "Got it" })),
    ],
    [
      "Escape",
      (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}"),
    ],
  ])("stays closed for good after %s", async (_label, closeWith) => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = renderSpotlight();
    await waitForOpen();
    await closeWith(user);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
    unmount();
    renderSpotlight();
    await waitForOpen();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("counts as seen once the user reaches Conformance on their own", async () => {
    renderSpotlight(true);
    await waitForOpen();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorage.getItem(CONFORMANCE_SPOTLIGHT_STORAGE_KEY)).toBe(
      "dismissed",
    );
  });

  it("never shows on mobile, where the sidebar is a sheet", async () => {
    fixture.isMobile = true;
    renderSpotlight();
    await waitForOpen();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorage.getItem(CONFORMANCE_SPOTLIGHT_STORAGE_KEY)).toBeNull();
  });
});
