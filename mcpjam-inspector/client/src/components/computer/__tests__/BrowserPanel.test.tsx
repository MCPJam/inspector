/**
 * The Browser Panel's token discipline.
 *
 * Both cases here are one incident (Sentry CONVEX-27Q). The panel minted a
 * fresh token on every request, and its two polling loops swallowed every
 * failure with `.catch(() => {})`. So a computer released or auto-paused under
 * an open panel produced one uncaught server error per minute per open tab,
 * for as long as the tab stayed open, while the panel itself showed nothing.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ConvexError } from "convex/values";

const mintProject = vi.fn();
const mintConversation = vi.fn();

// Both must be referentially STABLE across renders. `useAction` is; a mock
// that returns a fresh function each render rebuilds `getToken` → `authorized`
// → `refresh`, and the effect keyed on `refresh` then re-fires forever.
vi.mock("@/hooks/useProjectComputer", () => ({
  useMintBrowserToken: () => mintProject,
  useMintConversationBrowserToken: () => mintConversation,
}));

// Renders nothing, but keeps the props so a test can play the stream's part.
const stream = vi.hoisted(() => ({
  props: undefined as undefined | { onInput: () => void; viewOnly: boolean },
}));
vi.mock("../BrowserStream", () => ({
  BrowserStream: (props: { onInput: () => void; viewOnly: boolean }) => {
    stream.props = props;
    return null;
  },
}));
// The real save button, not a stub: it is a menu item, and stubbing it hid a
// panel that crashed the page the moment a browser connected.
vi.mock("@/lib/browser-profiles/availability", () => ({
  useBrowserProfileArchivesAvailable: () => true,
}));
vi.mock("@/lib/browser-profiles/client", () => ({
  saveBrowserProfile: vi.fn(),
}));

const setBrowserLocation = vi.fn();
const markBrowserSessionActive = vi.fn();
const useActiveChatSessionStore = Object.assign(
  (select: (s: unknown) => unknown) => select({ markBrowserSessionActive }),
  { getState: () => ({ setBrowserLocation }) },
);
vi.mock("@/stores/active-chat-session-store", () => ({
  get useActiveChatSessionStore() {
    return useActiveChatSessionStore;
  },
}));

import { BrowserPanel } from "../BrowserPanel";

/** A live `/session` answer, so the panel settles into WATCHING. */
function sessionOk() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      sessionId: "s-1",
      bootId: "b-1",
      lease: { state: "free" },
    }),
  } as unknown as Response;
}

describe("BrowserPanel token discipline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mintProject.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sessionOk()),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reuses one token across requests instead of minting per request", async () => {
    // Long-lived token so the keepalive tick lands well inside its lifetime.
    mintProject.mockResolvedValue({
      token: "tok",
      expiresAt: Date.now() + 600_000,
    });

    render(<BrowserPanel projectId="p1" />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    // Two requests went out — the initial /session and one /keepalive — and
    // they shared a single mint. Before this, that was two round trips to
    // Convex for a token already sitting in memory.
    expect(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
    expect(mintProject).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("reconnects a sleeping browser with lease ownership %s", async (yours) => {
    mintProject.mockResolvedValue({ token: "tok", expiresAt: Date.now() + 600_000 });
    let asleep = false;
    let leaseState = "held";
    const actions: string[] = [];
    let wakes = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/lease")) {
        const { action } = JSON.parse(String(init.body));
        actions.push(action);
        if (action === "heartbeat") asleep = true;
        if (action === "acquire") leaseState = "held";
      }
      if (url.endsWith("?ensure=1")) {
        wakes++;
        asleep = false;
        leaseState = "parked";
      }
      return asleep
        ? Response.json({ error: "no_browser_session" }, { status: 409 })
        : Response.json({ sessionId: "s1", bootId: "b1", yours: wakes === 0 || yours,
          lease: { state: leaseState, holder: "member" } });
    }));
    render(<BrowserPanel projectId="p1" />);
    await act(async () => {});
    expect(screen.getByText("You have control")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.queryByText("You have control")).toBeNull();
    expect(wakes).toBe(0);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reconnect browser" })); });
    expect(wakes).toBe(1);
    expect(actions).toEqual(yours ? ["heartbeat", "acquire"] : ["heartbeat"]);
    expect(screen.getByText(yours ? "You have control" : "Watching")).toBeTruthy();
  });

  it("keeps control when the lease can't be read right after taking it", async () => {
    mintProject.mockResolvedValue({ token: "tok", expiresAt: Date.now() + 600_000 });
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/lease")) {
        return Response.json({ ok: true, lease: { state: "held", holder: "member" } });
      }
      reads++;
      // After the acquire, the server could not read the lease this time.
      return Response.json({ sessionId: "s1", bootId: "b1", yours: false,
        lease: reads === 1 ? { state: "free" } : { state: "unknown" } });
    }));
    render(<BrowserPanel projectId="p1" />);
    await act(async () => {});
    expect(screen.getByText("Watching")).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Take control" })); });
    expect(reads).toBe(2);
    expect(screen.getByText("You have control")).toBeTruthy();
    expect(stream.props?.viewOnly).toBe(false);
  });

  it("keeps control when a read from before taking it lands after", async () => {
    mintProject.mockResolvedValue({
      token: "tok",
      expiresAt: Date.now() + 600_000,
    });
    let held = false;
    let landLate: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/lease")) {
          held = true;
          return Response.json({
            ok: true,
            lease: { state: "held", holder: "member" },
          });
        }
        // Each read answers with the lease as it was when the read started.
        const answer = Response.json({
          sessionId: "s1",
          bootId: "b1",
          yours: held,
          lease: held ? { state: "held", holder: "member" } : { state: "free" },
        });
        // The first read that `ensure` starts is slow, and lands last.
        if (url.endsWith("?ensure=1") && !landLate) {
          return new Promise<Response>((resolve) => {
            landLate = () => resolve(answer);
          });
        }
        return answer;
      }),
    );
    const { rerender } = render(<BrowserPanel projectId="p1" />);
    await act(async () => {});
    rerender(<BrowserPanel projectId="p1" ensure />);
    await act(async () => {});
    expect(landLate).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    });
    expect(screen.getByText("You have control")).toBeTruthy();
    await act(async () => landLate!());
    expect(screen.getByText("You have control")).toBeTruthy();
    expect(stream.props?.viewOnly).toBe(false);
  });

  it("pings /input-ping for the stream's input at most once a minute", async () => {
    mintProject.mockResolvedValue({ token: "tok", expiresAt: Date.now() + 600_000 });
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const pings = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/input-ping")).length;
    render(<BrowserPanel projectId="p1" />);
    await act(async () => {});

    await act(async () => { stream.props!.onInput(); stream.props!.onInput(); });
    expect(pings()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await act(async () => { stream.props!.onInput(); });
    expect(pings()).toBe(2);
  });

  it("leaves input to the pane's own ping when the pane passes one", async () => {
    mintProject.mockResolvedValue({ token: "tok", expiresAt: Date.now() + 600_000 });
    const paneInput = vi.fn();
    render(<BrowserPanel projectId="p1" onInput={paneInput} />);
    await act(async () => {});

    await act(async () => { stream.props!.onInput(); });
    expect(paneInput).toHaveBeenCalledOnce();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/input-ping"))).toBe(false);
  });

  it("stops polling and says so when the browser goes away", async () => {
    // First mint succeeds so the panel reaches WATCHING; the computer is then
    // released, so the re-mint after the token lapses reports it.
    mintProject
      .mockResolvedValueOnce({ token: "tok", expiresAt: Date.now() + 60_000 })
      .mockRejectedValue(
        new ConvexError({
          kind: "browser_unavailable",
          message:
            "No active desktop computer for this project — reserve one first",
        }),
      );

    render(<BrowserPanel projectId="p1" />);
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByText(/reserve one first/)).toBeTruthy();

    const afterStop = mintProject.mock.calls.length;
    // Five more minutes of wall clock. The loop is gone, so nothing else is
    // attempted — this is the assertion that the error-per-minute stops.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(mintProject).toHaveBeenCalledTimes(afterStop);
  });
});

describe("BrowserPanel toolbar", () => {
  beforeEach(() => {
    mintProject.mockReset();
    mintProject.mockResolvedValue({
      token: "tok",
      expiresAt: Date.now() + 600_000,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sessionOk()),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers saving the profile from a menu once the browser is live", async () => {
    render(<BrowserPanel projectId="p1" />);
    const trigger = await screen.findByLabelText("More browser actions");
    expect(screen.getByText("Watching")).toBeTruthy();

    fireEvent.pointerDown(
      trigger,
      new MouseEvent("pointerdown", { bubbles: true }) as never,
    );
    fireEvent.click(trigger);

    expect(
      await screen.findByText("Save profile for other chats…"),
    ).toBeTruthy();
  });
});
