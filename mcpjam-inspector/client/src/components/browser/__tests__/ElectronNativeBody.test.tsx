import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ElectronNativeBody } from "../ElectronNativeBody";
import {
  BROWSER_PANE_STATS_FLAG,
  paneFrameStats,
} from "@/lib/browser-pane/frame-stats";

/** Every `setViewport` the pane asked for, in order. */
let asked: Array<{
  bootId: string;
  holder?: string;
  visible: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}> = [];
/** What the main process answers next. */
let answer: {
  shown: boolean;
  inputAllowed: boolean;
  reason?: "unknown" | "no_window" | "bad_bounds" | "lease";
} = { shown: true, inputAllowed: false };

const RECT = { x: 12, y: 34, width: 640, height: 480 };
let realRect: typeof Element.prototype.getBoundingClientRect;

beforeEach(() => {
  asked = [];
  answer = { shown: true, inputAllowed: false };
  // jsdom lays nothing out, so every rectangle is zero — which the main
  // process would (correctly) refuse as "not a rectangle".
  realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    return {
      ...RECT,
      top: RECT.y,
      left: RECT.x,
      right: RECT.x + RECT.width,
      bottom: RECT.y + RECT.height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  (window as unknown as { electronAPI?: unknown }).electronAPI = {
    agentBrowser: {
      capability: async () => ({ available: true }),
      setViewport: async (request: (typeof asked)[number]) => {
        asked.push(request);
        return answer;
      },
    },
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

function renderBody(over: Record<string, unknown> = {}) {
  return render(
    <ElectronNativeBody
      session={{ bootId: "boot-1" }}
      holder="rail-1"
      control="agent"
      holding={false}
      consentGranted
      {...(over as never)}
    />,
  );
}

/** The last ask, once one has landed. */
const lastAsk = async () => {
  await waitFor(() => expect(asked.length).toBeGreaterThan(0));
  return asked[asked.length - 1]!;
};

describe("the native Electron browser pane", () => {
  it("asks for the view at the slot it measured", async () => {
    renderBody();
    expect(await lastAsk()).toEqual({
      bootId: "boot-1",
      holder: "rail-1",
      takeover: false,
      visible: true,
      bounds: { x: RECT.x, y: RECT.y, width: RECT.width, height: RECT.height },
    });
    expect(
      (await screen.findByTestId("rail-browser-native-slot")).getAttribute(
        "data-shown",
      ),
    ).toBe("true");
  });

  it("draws no picture at all", async () => {
    // The whole point: the person is looking at Chromium, not at a JPEG of it.
    // A canvas here would mean the frame socket was still paying for an encode
    // nobody sees.
    renderBody();
    await lastAsk();
    expect(screen.queryByTestId("rail-browser-frame")).toBeNull();
    expect(document.querySelector("canvas")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("takes the view out of the window when the pane stops being visible", async () => {
    // A native view is a SIBLING of the renderer: it keeps painting a live
    // browser over whatever the rail switched to. Hiding the DOM node does
    // nothing.
    const { rerender } = renderBody();
    await lastAsk();
    rerender(
      <ElectronNativeBody
        session={{ bootId: "boot-1" }}
        holder="rail-1"
        control="agent"
        holding={false}
        consentGranted
        active={false}
      />,
    );
    await waitFor(async () => expect((await lastAsk()).visible).toBe(false));
  });

  it("takes the view out when the machine's consent is withdrawn", async () => {
    // A placeholder cannot cover a native view — it paints OVER the app — so a
    // revoked grant has to remove it from the window, not draw over it.
    const { rerender } = renderBody();
    await lastAsk();
    rerender(
      <ElectronNativeBody
        session={{ bootId: "boot-1" }}
        holder="rail-1"
        control="agent"
        holding={false}
        consentGranted={false}
      />,
    );
    await waitFor(async () => expect((await lastAsk()).visible).toBe(false));
  });

  it("takes the view out on the way past", async () => {
    const { unmount } = renderBody();
    await lastAsk();
    unmount();
    await waitFor(async () => {
      const last = await lastAsk();
      expect(last.visible).toBe(false);
      expect(last.bootId).toBe("boot-1");
    });
  });

  it("takes the OLD browser out when the pane moves to another one", async () => {
    // A native view can only be removed BY NAME, and by the time the pane
    // knows it should go, `session` is already the next project's. Without
    // remembering what is parented, the previous project's page stays painted
    // over the rail.
    const { rerender } = renderBody();
    await lastAsk();
    rerender(
      <ElectronNativeBody
        session={{ bootId: "boot-2" }}
        holder="rail-1"
        control="agent"
        holding={false}
        consentGranted
      />,
    );
    await waitFor(() =>
      expect(
        asked.some((a) => a.bootId === "boot-1" && a.visible === false),
      ).toBe(true),
    );
    expect(await lastAsk()).toMatchObject({ bootId: "boot-2", visible: true });
  });

  it("takes the view out when the browser it was watching stops", async () => {
    const { rerender } = renderBody();
    await lastAsk();
    rerender(
      <ElectronNativeBody
        session={null}
        holder="rail-1"
        control="agent"
        holding={false}
        consentGranted
      />,
    );
    await waitFor(async () => {
      const last = await lastAsk();
      expect(last).toEqual({ bootId: "boot-1", visible: false });
    });
  });

  it("puts the stats in the flow, where the view cannot paint over them", async () => {
    // A `WebContentsView` is a sibling of the renderer: an overlay inside the
    // rectangle it was given is in the DOM and invisible on the glass.
    localStorage.setItem(BROWSER_PANE_STATS_FLAG, "1");
    paneFrameStats.resetFlagForTests();
    try {
      renderBody();
      await lastAsk();
      const overlay = await screen.findByTestId("pane-stats-overlay");
      expect(overlay.className).not.toContain("absolute");
    } finally {
      localStorage.clear();
      paneFrameStats.resetFlagForTests();
    }
  });

  it("never asks with no browser to ask about", async () => {
    renderBody({ session: null });
    // A tick, so a `requestAnimationFrame` that was going to fire has.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toEqual([]);
  });

  it("says why the slot is empty when somebody else holds the browser", async () => {
    answer = { shown: false, inputAllowed: false, reason: "lease" };
    renderBody({ control: "other" });
    expect(await screen.findByTestId("rail-browser-native-lease")).toBeTruthy();
    // And the slot is still measured, so the view can come back the moment the
    // lease frees.
    expect(screen.getByTestId("rail-browser-native-slot")).toBeTruthy();
  });

  it("says so when the browser it was watching has gone", async () => {
    answer = { shown: false, inputAllowed: false, reason: "unknown" };
    renderBody();
    expect(await screen.findByTestId("rail-browser-native-gone")).toBeTruthy();
  });

  it("shows the engine's own placeholder ahead of anything else", async () => {
    renderBody({
      session: null,
      placeholder: <span data-testid="rail-browser-idle">Nothing yet</span>,
    });
    expect(await screen.findByTestId("rail-browser-idle")).toBeTruthy();
  });

  it("offers take control and hand back, like every other engine", async () => {
    const onTakeControl = vi.fn();
    renderBody({ onTakeControl });
    (await screen.findByText("Take control")).click();
    expect(onTakeControl).toHaveBeenCalled();
  });

  it("re-asks when the lease moves, so the answer stops being stale", async () => {
    const { rerender } = renderBody();
    await lastAsk();
    const before = asked.length;
    rerender(
      <ElectronNativeBody
        session={{ bootId: "boot-1" }}
        holder="rail-1"
        control="you"
        holding
        consentGranted
      />,
    );
    await waitFor(() => expect(asked.length).toBeGreaterThan(before));
  });

  it("survives a main process that is not there", async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    renderBody();
    expect(await screen.findByTestId("rail-browser-native-slot")).toBeTruthy();
  });
});
