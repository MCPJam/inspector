/**
 * The whole server stack against a real browser: provider, runtime, registry.
 *
 * The spike test proves what the CDP domain does; this proves that our
 * translation of it is right — that tools become stable keys, that a hanging
 * tool times out, that navigation does not leave ghosts in the registry.
 *
 * Runs headless. A user-facing session is headed, but headed needs a display
 * and would make this suite unrunnable in CI.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { chromium } from "playwright";
import { isChromiumInstalled } from "../../../utils/browser-rendering-setup";
import { startWebMcpSession, WebMcpSessionRegistry } from "../session-registry";
import { PlaywrightWebMcpProvider } from "../playwright-provider";
import { WebMcpToolGoneError } from "../provider";
import {
  WEBMCP_FRAME_MAX_BYTES,
  WEBMCP_VIEWPORT,
  type WebMcpActivityEntry,
  type WebMcpFrame,
} from "@/shared/webmcp-inspector-protocol";
import { readJpegDimensions } from "@/shared/jpeg-dimensions";
import {
  FIXTURE_INPUT_TARGETS,
  startWebMcpFixtureServer,
  type WebMcpFixture,
} from "./fixture-page";
import { buildWebMcpLaunchArgs } from "../launch-args";

const CHROMIUM_AVAILABLE = await isChromiumInstalled();
const WEBMCP_CDP_AVAILABLE = await (async () => {
  if (!CHROMIUM_AVAILABLE) return false;
  const browser = await chromium.launch({
    headless: true,
    args: buildWebMcpLaunchArgs(),
  });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebMCP.enable" as never);
    return true;
  } catch {
    return false;
  } finally {
    await browser.close().catch(() => {});
  }
})();
if (process.env.CI && !CHROMIUM_AVAILABLE) {
  throw new Error(
    "WebMCP provider integration requires Chromium, preinstalled in the pinned CI image.",
  );
}
if (process.env.CI && CHROMIUM_AVAILABLE && !WEBMCP_CDP_AVAILABLE) {
  throw new Error(
    "WebMCP provider integration requires a Chromium build exposing the " +
      "WebMCP domain. Install the pinned Playwright browser before running CI.",
  );
}

/** Headless for tests; a real session opens a window the developer drives. */
class HeadlessProvider extends PlaywrightWebMcpProvider {
  async createSession(
    options: Parameters<PlaywrightWebMcpProvider["createSession"]>[0],
  ) {
    return super.createSession({ ...options, headless: true });
  }
}

describe.skipIf(!WEBMCP_CDP_AVAILABLE)("WebMCP provider — real browser", () => {
  let fixture: WebMcpFixture;
  let registry: WebMcpSessionRegistry;
  const provider = new HeadlessProvider();

  beforeAll(async () => {
    fixture = await startWebMcpFixtureServer();
  }, 60_000);

  afterAll(async () => {
    await registry?.disposeAll({ permanent: true });
    await fixture?.close();
  });

  afterEach(async () => {
    await registry?.disposeAll();
  });

  async function open(
    options: {
      viewportMode?: "window" | "embedded";
      devicePixelRatio?: number;
    } = {},
  ) {
    registry = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const session = await startWebMcpSession({
      url: fixture.url,
      provider,
      registry,
      headless: true,
      ...(options.viewportMode ? { viewportMode: options.viewportMode } : {}),
      ...(options.devicePixelRatio !== undefined
        ? { devicePixelRatio: options.devicePixelRatio }
        : {}),
    });
    const runtime = registry.get(session.sessionId);
    const activity: WebMcpActivityEntry[] = [];
    const frames: WebMcpFrame[] = [];
    runtime.hub.subscribe((event) => {
      if (event.type === "activity") activity.push(event.entry);
      if (event.type === "frame") frames.push(event.frame);
    }, 0);
    return { session, runtime, activity, frames };
  }

  it("discovers the page's tools with stable keys and provenance", async () => {
    const { runtime } = await open();
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThanOrEqual(5),
    );

    const tools = runtime.currentTools();
    const echo = tools.find((tool) => tool.name === "echo");
    expect(echo).toBeDefined();
    expect(echo!.toolKey).toBe(`${new URL(fixture.url).origin}::echo`);
    expect(echo!.fromSubframe).toBe(false);
    expect(echo!.registrationKind).toBe("imperative");
    expect(echo!.inputSchema).toMatchObject({ type: "object" });

    // The cross-origin subframe's tool is invisible to this session, as the
    // spike established. V1 scope is main frame plus same-process frames.
    expect(tools.map((tool) => tool.name)).not.toContain("sub_tool");
    await registry.disposeAll();
  }, 60_000);

  it("invokes a tool and reports the result on the timeline", async () => {
    const { runtime, activity } = await open();
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThan(0),
    );

    const origin = new URL(fixture.url).origin;
    const { invokeId, settled } = runtime.invoke(
      `${origin}::echo`,
      { text: "hello" },
      "manual",
    );
    const result = await settled;
    // The MCP-shaped result object survives the CDP hop intact.
    expect(result.output).toMatchObject({
      content: [{ type: "text", text: 'echo:{"text":"hello"}' }],
    });

    await vi.waitFor(() => {
      const done = activity.find(
        (entry) =>
          entry.kind === "invocation_settled" && entry.invokeId === invokeId,
      );
      expect(done).toBeDefined();
      expect(done && "state" in done ? done.state : undefined).toBe(
        "succeeded",
      );
    });
    await registry.disposeAll();
  }, 60_000);

  it("surfaces a thrown page tool as a failure with its message", async () => {
    const { runtime } = await open();
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThan(0),
    );
    const origin = new URL(fixture.url).origin;

    await expect(
      runtime.invoke(`${origin}::boom`, {}, "manual").settled,
    ).rejects.toThrow(/intentional failure/);
    await registry.disposeAll();
  }, 60_000);

  it("times out a tool that never responds, and stays usable afterwards", async () => {
    registry = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const session = await startWebMcpSession({
      url: fixture.url,
      provider,
      registry,
      headless: true,
    });
    const runtime = registry.get(session.sessionId);
    // A short timeout keeps the suite quick; the production default is 60s.
    Reflect.set(runtime, "invokeTimeoutMs", 2_000);
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThan(0),
    );
    const origin = new URL(fixture.url).origin;

    const activity: WebMcpActivityEntry[] = [];
    runtime.hub.subscribe((event) => {
      if (event.type === "activity") activity.push(event.entry);
    }, 0);

    // ONE invocation, and its rejection is consumed exactly once. Starting a
    // second `slow` to read an id from would queue behind this one's full
    // timeout and leave the first promise rejecting with nobody listening —
    // which vitest reports as an unhandled rejection and fails the run.
    const hung = runtime.invoke(`${origin}::slow`, {}, "manual");
    await expect(hung.settled).rejects.toThrow(
      /did not respond in time|cancel/i,
    );

    // END TO END, through the shared bridge: the RUNTIME owns the deadline, so
    // the browser's `Canceled` — which says nothing about why — must still be
    // recorded as a timeout and not as a user cancellation. That distinction is
    // the whole reason the reason is carried, and it is the exact bug a naive
    // adoption of the bridge introduces.
    await vi.waitFor(() => {
      const settled = activity.find(
        (entry) =>
          entry.kind === "invocation_settled" &&
          entry.invokeId === hung.invokeId,
      );
      expect(settled && "state" in settled ? settled.state : undefined).toBe(
        "timeout",
      );
    });

    // The session must survive a hung tool: the next call still works.
    const after = await runtime.invoke(
      `${origin}::echo`,
      { text: "after" },
      "manual",
    ).settled;
    expect(JSON.stringify(after.output)).toContain("after");
    await registry.disposeAll();
  }, 60_000);

  it("truncates an oversized result at the cap", async () => {
    const { runtime } = await open();
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThan(0),
    );
    const origin = new URL(fixture.url).origin;

    const { truncated, output } = await runtime.invoke(
      `${origin}::big`,
      {},
      "manual",
    ).settled;
    expect(truncated).toBe(true);
    expect(String(output)).toContain("truncated");
    await registry.disposeAll();
  }, 60_000);

  it("drops the old page's tools on navigation", async () => {
    const { runtime } = await open();
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThan(0),
    );

    await runtime.navigateCommand({ type: "navigate", url: fixture.nextUrl });

    // Chromium reports no removal here, so this only passes because the
    // provider synthesizes it. Without that, `echo` would linger forever and
    // invoking it would fail against a page that no longer has it.
    await vi.waitFor(() => {
      const names = runtime.currentTools().map((tool) => tool.name);
      expect(names).toContain("page2_tool");
      expect(names).not.toContain("echo");
    });

    const origin = new URL(fixture.url).origin;
    await expect(
      runtime.invoke(`${origin}::echo`, {}, "manual").settled,
    ).rejects.toBeInstanceOf(WebMcpToolGoneError);
    await registry.disposeAll();
  }, 60_000);

  it("reports a headless session as having no viewport", async () => {
    const { session } = await open();
    // The UI reads this to decide whether to tell someone to go look at a
    // window. Claiming `native-window` here would point them at one that does
    // not exist — the state an inspector reached over SSH is always in.
    expect(session.viewportTransport).toEqual({ kind: "headless" });
    await registry.disposeAll();
  }, 60_000);

  it("records session_started before the navigation it caused", async () => {
    const { runtime } = await open();
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThan(0),
    );
    const kinds = runtime.hub
      .buffered()
      .flatMap((event) =>
        event.type === "activity" ? [event.entry.kind] : [],
      );
    // The browser navigates and registers tools while starting up, so an entry
    // written after `attach` would land behind them and the timeline would read
    // "navigated, tools added, session started".
    expect(kinds[0]).toBe("session_started");
    expect(kinds).toContain("navigated");
    await registry.disposeAll();
  }, 60_000);

  it("captures a screenshot for the timeline", async () => {
    const { runtime } = await open();
    const shot = await runtime.screenshotNow();
    expect(typeof shot).toBe("string");
    expect((shot ?? "").length).toBeGreaterThan(100);
    await registry.disposeAll();
  }, 60_000);

  it("streams the page, keeps its ack loop turning, and stops on demand", async () => {
    const { runtime, frames } = await open();
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThan(0),
    );

    await runtime.setScreencast(true);
    // A frame at all proves the whole chain: Playwright's new headless answers
    // `Page.startScreencast`, the session's existing CDPSession carries the
    // events, and the runtime publishes them.
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1), {
      timeout: 15_000,
    });

    const first = frames.at(-1)!;
    expect(first.data.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(first.data, "base64")).toBeLessThanOrEqual(
      WEBMCP_FRAME_MAX_BYTES,
    );
    expect(first.deviceWidth).toBeGreaterThan(0);
    expect(first.deviceHeight).toBeGreaterThan(0);

    // Chromium gates the next frame on our ack, so a wedged ack loop shows up
    // as a stream that delivers one frame and then goes quiet forever. Repaint
    // the page and require another frame to prove it is still turning.
    const before = frames.length;
    await runtime.navigateCommand({ type: "reload" });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(before), {
      timeout: 15_000,
    });

    // WHILE STREAMING: the replay buffer holds exactly ONE frame, however many
    // hundreds were published into it — and every timeline entry is still
    // there beside it. That is the whole point of the coalesced slot.
    //
    // Polled rather than read once: the reload above clears the retained frame
    // (`onNavigated` → `hub.clearFrame()`), and a frame delivered just BEFORE
    // that event leaves the slot empty for as long as it takes the page to
    // paint again — which on a loaded runner is longer than the counter this
    // waits on suggests. Polling keeps the claim exactly as strong (a slot
    // that settled at two frames still fails) without racing the repaint.
    await vi.waitFor(
      () =>
        expect(
          runtime.hub.buffered().filter((event) => event.type === "frame"),
        ).toHaveLength(1),
      { timeout: 15_000 },
    );
    const streaming = runtime.hub.buffered();
    const streamingActivity = streaming.filter(
      (event) => event.type === "activity",
    );
    const streamingKinds = streamingActivity.map((event) => event.entry.kind);
    // Identities, not kinds, for the prefix check below — see the comment there.
    const streamingIds = streamingActivity.map((event) => event.entry.id);
    expect(streamingKinds).toContain("session_started");
    expect(streamingKinds).toContain("tools_added");
    expect(streamingKinds).toContain("navigated");

    await runtime.setScreencast(false);
    // Let anything already in flight land, then require quiet.
    await new Promise((resolve) => setTimeout(resolve, 750));
    const afterStop = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(frames.length).toBe(afterStop);

    // AFTER STOPPING: no frame at all. Replay promises a reconnecting client
    // the CURRENT paint, and once the stream is withdrawn there is none — a
    // retained one would be handed over as though it were live.
    const stopped = runtime.hub.buffered();
    expect(stopped.filter((event) => event.type === "frame")).toHaveLength(0);
    // The timeline is untouched by any of it: every entry that was there
    // before the stop is still there, in the same order.
    //
    // A PREFIX rather than an equality, and the difference is a real race
    // rather than a nicety. `streamingIds` was sampled the moment a frame
    // arrived after the reload — but the reloaded page re-registers its tools
    // asynchronously, in however many batches Chromium happens to deliver, and
    // the two 750ms sleeps above give it 1.5 seconds to add more. Demanding
    // equality asserts that a live browser stopped doing anything at all,
    // which is not a property this test is about and not one the code
    // provides. What the stop must not do is LOSE or REORDER an entry, and
    // that is what this checks.
    //
    // Compared by `id` rather than `kind`: a run of `tools_added` entries all
    // carry the same kind, so a prefix of kinds would still match if the stop
    // dropped one and the reloading page happened to add another. Identity is
    // the only thing that says THESE entries survived.
    const stoppedIds = stopped
      .filter((event) => event.type === "activity")
      .map((event) => event.entry.id);
    expect(stoppedIds.slice(0, streamingIds.length)).toEqual(streamingIds);

    await registry.disposeAll();
  }, 60_000);

  it("describes every frame by its own bytes, at the viewer's pixel ratio", async () => {
    // THE GATE for the one thing about this that cannot be reasoned out: what
    // a real Chromium actually hands over when the context renders at two
    // device pixels per CSS pixel. Measured against 141 headless, a screencast
    // is clamped to the CSS size of the surface — `maxWidth` can only scale a
    // capture DOWN — so the frames come back 1280x800, supersampled from a
    // 2560x1600 raster rather than delivered at it.
    //
    // Which is exactly why nothing here asserts a NUMBER of pixels. What must
    // hold, on any build and at any ratio, is that a frame's reported geometry
    // matches the picture inside it: that is the property every forwarded click
    // is scaled by, and the one that turns a wrong assumption into a wrong
    // coordinate.
    const { session, frames } = await open({
      viewportMode: "embedded",
      devicePixelRatio: 2,
    });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1), {
      timeout: 15_000,
    });

    for (const frame of frames) {
      const bytes = Buffer.from(frame.data, "base64");
      expect(bytes.byteLength).toBeLessThanOrEqual(WEBMCP_FRAME_MAX_BYTES);
      const sof = readJpegDimensions(bytes);
      expect(sof, "a published frame should be a decodable JPEG").toBeDefined();
      // The picture and the label agree…
      expect(frame.deviceWidth).toBe(sof!.width);
      expect(frame.deviceHeight).toBe(sof!.height);
      // …and the scale is the ratio between the picture and the page's own
      // coordinate space, whatever this browser chose to give us.
      expect(frame.scale).toBeCloseTo(sof!.width / WEBMCP_VIEWPORT.width, 2);
    }
    expect(session.viewportTransport).toEqual({
      kind: "frame-stream",
      ...WEBMCP_VIEWPORT,
    });
    await registry.disposeAll();
  }, 60_000);

  it("sharpens the picture once the page stops painting", async () => {
    // The fixture paints on load and then stops, which is the case the settle
    // still exists for: what a person reads is the picture still on screen a
    // second after everything stopped moving, and the stream is encoded for
    // motion.
    const { frames } = await open({ viewportMode: "embedded" });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1), {
      timeout: 15_000,
    });

    // Long enough for the page's own paints to stop and for the quiet window
    // to elapse. The LAST frame after that can only be the still: an unchanged
    // repaint is dropped as redundant, which is what stops the capture's own
    // induced frame from inducing another capture.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(frames.length, "a still after the paints").toBeGreaterThanOrEqual(2);

    const settled = frames.at(-1)!;
    const streamed = frames.at(-2)!;
    // Same picture, more bytes: the still is encoded well above the streaming
    // baseline, which is the entire point of taking it.
    expect(Buffer.byteLength(settled.data, "base64")).toBeGreaterThan(
      Buffer.byteLength(streamed.data, "base64"),
    );
    expect(Buffer.byteLength(settled.data, "base64")).toBeLessThanOrEqual(
      WEBMCP_FRAME_MAX_BYTES,
    );
    await registry.disposeAll();
  }, 60_000);

  it("boots an embedded session that streams unprompted and takes input", async () => {
    const { session, runtime, frames } = await open({
      viewportMode: "embedded",
    });

    // No window, and the client is told so: `frame-stream` rather than
    // `headless`, which would say there is nothing here to drive.
    expect(session.viewportTransport).toEqual({
      kind: "frame-stream",
      width: 1280,
      height: 800,
    });
    // Nobody asked for the stream. Nothing else would ever turn it on, and a
    // headless browser with no stream is a session with no viewport at all.
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1), {
      timeout: 15_000,
    });

    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThan(0),
    );
    const origin = new URL(fixture.url).origin;
    const named = (name: string) =>
      runtime.currentTools().some((tool) => tool.name === name);
    expect(named(FIXTURE_INPUT_TARGETS.clickedTool)).toBe(false);

    // A click, as the pane's forwarder would send it. Observed through the tool
    // registry rather than by evaluating in the page: the registry is the
    // channel the product actually uses, so a pass here cannot be a pass on a
    // path nobody looks at.
    const { x, y } = FIXTURE_INPUT_TARGETS.button;
    await runtime.dispatchInput([
      { kind: "mouse_move", x, y },
      { kind: "mouse_down", x, y, button: "left" },
      { kind: "mouse_up", x, y, button: "left" },
    ]);
    await vi.waitFor(
      () => expect(named(FIXTURE_INPUT_TARGETS.clickedTool)).toBe(true),
      { timeout: 10_000 },
    );
    expect(
      runtime
        .currentTools()
        .find((tool) => tool.name === FIXTURE_INPUT_TARGETS.clickedTool)
        ?.toolKey,
    ).toBe(`${origin}::${FIXTURE_INPUT_TARGETS.clickedTool}`);

    // Typed text lands in the focused field.
    const field = FIXTURE_INPUT_TARGETS.field;
    await runtime.dispatchInput([
      { kind: "mouse_move", x: field.x, y: field.y },
      { kind: "mouse_down", x: field.x, y: field.y, button: "left" },
      { kind: "mouse_up", x: field.x, y: field.y, button: "left" },
      { kind: "text", text: "hi" },
    ]);
    await vi.waitFor(
      () => expect(named(FIXTURE_INPUT_TARGETS.typedTool)).toBe(true),
      { timeout: 10_000 },
    );

    await registry.disposeAll();
  }, 90_000);

  it("leaves a window session's transport to the headless flag", async () => {
    // This whole suite runs headless (a headed session needs a display), so a
    // WINDOW session here reports `headless` — which is the point: the viewport
    // mode does not touch that path at all. A real window session on a machine
    // with a display still reports `native-window`.
    const { session } = await open();
    expect(session.viewportTransport).toEqual({ kind: "headless" });
    await registry.disposeAll();
  }, 60_000);
});
