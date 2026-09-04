/**
 * End-to-end coverage of the WebMCP viewport frame stream, against the REAL
 * server and a REAL Chromium.
 *
 * The unit suites prove each piece in isolation with a fake browser and a fake
 * socket. This proves the pieces meet: a real CDP screencast, encoded by the
 * real route, over a real WebSocket, decoded by the shared codec that the
 * client compiles too — and it measures the thing the change exists for, so
 * "it feels faster" has a number attached.
 *
 * Driven through the HTTP + WebSocket API rather than the inspector's own UI,
 * because the `/webmcp` screen sits behind a PostHog rollout flag that a
 * headless run cannot resolve. What that leaves uncovered — the pane's `<img>`
 * and the store's ladder — is covered by the store, presenter and tab suites,
 * which is the right place for it: those are decisions, not integrations.
 */
import { expect, test } from "@playwright/test";
import { WebSocket } from "ws";
import {
  decodeWebMcpBinaryFrame,
  WEBMCP_FRAME_BOOST_INTERVAL_MS,
  WEBMCP_FRAME_MAX_BYTES,
  WEBMCP_FRAME_MIN_INTERVAL_MS,
  WEBMCP_SETTLE_QUIET_MS,
  WEBMCP_STREAM_QUALITY_LADDER,
  type WebMcpBinaryFrame,
} from "../shared/webmcp-inspector-protocol";
import { readJpegDimensions } from "../shared/jpeg-dimensions";
import { startWebMcpFixturePage } from "./fixtures/webmcp-frame-page";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:6274";
/** The inspector serves its token only to a localhost Origin. */
const ORIGIN = BASE;

/**
 * The WebMCP Inspector is LOCAL-ONLY by construction: `/api/mcp/*` is not
 * mounted in hosted mode, the browser would have to run on the machine
 * serving the page, and the session token is served to localhost alone. So
 * against a deployed target — the post-deploy staging lane sets
 * `PLAYWRIGHT_BASE_URL` — there is nothing here to test, and running anyway
 * would report a product failure for a surface that is correctly absent.
 */
const LOCAL_TARGET =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE);

async function sessionToken(): Promise<string> {
  const res = await fetch(`${BASE}/api/session-token`, {
    headers: { Origin: ORIGIN },
  });
  expect(
    res.ok,
    "the inspector should serve its session token to localhost",
  ).toBe(true);
  const body = (await res.json()) as { token?: string };
  expect(body.token, "session token").toBeTruthy();
  return body.token!;
}

function authed(token: string, extra: Record<string, string> = {}) {
  return {
    "X-MCP-Session-Auth": `Bearer ${token}`,
    Origin: ORIGIN,
    ...extra,
  };
}

async function command(
  token: string,
  sessionId: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${BASE}/api/mcp/webmcp/sessions/${sessionId}/command`,
    {
      method: "POST",
      headers: authed(token, { "content-type": "application/json" }),
      body: JSON.stringify(payload),
    },
  );
  const body = (await res.json()) as Record<string, unknown>;
  expect(
    res.ok,
    `command ${JSON.stringify(payload)} → ${JSON.stringify(body)}`,
  ).toBe(true);
  return body;
}

/** A frame socket that records what it decodes, with arrival times. */
function openFrameSocket(token: string, sessionId: string) {
  const url = `${BASE.replace(/^http/, "ws")}/api/web/webmcp/sessions/${sessionId}/frames`;
  const ws = new WebSocket(url, [token], { origin: ORIGIN });
  const frames: Array<WebMcpBinaryFrame & { receivedAt: number }> = [];
  const undecodable: number[] = [];
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const bytes = data as Buffer;
    const frame = decodeWebMcpBinaryFrame(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
    if (!frame) {
      undecodable.push(bytes.byteLength);
      return;
    }
    frames.push({ ...frame, receivedAt: Date.now() });
  });
  return {
    ws,
    frames,
    undecodable,
    opened: new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("close", (code) =>
        reject(new Error(`closed ${code} before opening`)),
      );
      ws.on("error", () => {});
    }),
    close: () => ws.close(),
  };
}

/** Read an SSE stream for `ms`, returning the raw text. */
async function readSse(
  token: string,
  sessionId: string,
  query: string,
  ms: number,
): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(
    `${BASE}/api/mcp/webmcp/sessions/${sessionId}/events?${query}`,
    { headers: authed(token), signal: controller.signal },
  );
  expect(res.ok).toBe(true);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())),
        ),
      ]);
      if (!chunk || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    controller.abort();
  }
  return text;
}

/**
 * Parse an SSE body into the events it carried.
 *
 * `readSse` hands back raw text because most assertions here are about what a
 * stream does or does not contain. The governor's are about a VALUE that
 * changes over time, and "the newest session event" is not something a
 * substring can answer.
 */
function parseSseEvents(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of text.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed && typeof parsed === "object") {
          events.push(parsed as Record<string, unknown>);
        }
      } catch {
        // A half-written chunk at the end of the read window.
      }
    }
  }
  return events;
}

/** The quality the newest session event reports, if any. */
function latestStreamQuality(text: string): number | undefined {
  const sessions = parseSseEvents(text).filter(
    (event) => event.type === "session",
  );
  const newest = sessions.at(-1)?.session as
    { streamQuality?: number } | undefined;
  return newest?.streamQuality;
}

/**
 * Invoke a page tool by NAME and hand back what it returned.
 *
 * The tool key is `${origin}::${name}`, but it is read off the session's own
 * `tools` event rather than constructed here: the key is the runtime's to
 * assign, and a test that rebuilt it would pass while the two disagreed.
 */
async function invokePageTool(
  token: string,
  sessionId: string,
  name: string,
): Promise<unknown> {
  const tools = parseSseEvents(
    await readSse(token, sessionId, "replay=200&frames=off", 1_500),
  ).filter((event) => event.type === "tools");
  const descriptors = (tools.at(-1)?.tools ?? []) as Array<{
    toolKey: string;
    name: string;
  }>;
  const tool = descriptors.find((entry) => entry.name === name);
  expect(
    tool,
    `the fixture should register ${name}; saw ${descriptors
      .map((entry) => entry.name)
      .join(", ")}`,
  ).toBeDefined();

  await command(token, sessionId, {
    type: "invoke_tool",
    toolKey: tool!.toolKey,
    input: {},
    source: "manual",
  });

  // The result arrives on the TIMELINE rather than in the command's response:
  // an invocation is asynchronous, and the settle entry is where it lands.
  let output: unknown;
  await expect
    .poll(
      async () => {
        const settled = parseSseEvents(
          await readSse(token, sessionId, "replay=200&frames=off", 1_000),
        )
          .filter((event) => event.type === "activity")
          .map((event) => event.entry as { kind?: string; output?: unknown })
          .filter((entry) => entry?.kind === "invocation_settled");
        output = settled.at(-1)?.output;
        return output !== undefined;
      },
      { message: `${name} should settle`, timeout: 20_000 },
    )
    .toBe(true);
  return output;
}

/** The JSON a fixture tool put in its first text block. */
function toolJson(output: unknown): Record<string, number> {
  const text = (output as { content?: Array<{ text?: string }> })?.content?.[0]
    ?.text;
  expect(
    text,
    `tool output should carry a text block: ${JSON.stringify(output)}`,
  ).toBeTruthy();
  return JSON.parse(text!) as Record<string, number>;
}

/** Open a session, failing loudly with the server's own words if it refuses. */
async function openSession(
  token: string,
  body: Record<string, unknown>,
): Promise<{
  sessionId: string;
  viewportTransport?: { kind?: string; width?: number; height?: number };
}> {
  const created = await fetch(`${BASE}/api/mcp/webmcp/sessions`, {
    method: "POST",
    headers: authed(token, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  const session = (await created.json()) as {
    sessionId?: string;
    viewportTransport?: { kind?: string; width?: number; height?: number };
    error?: string;
  };
  expect(
    created.status,
    `session start failed: ${JSON.stringify(session)}`,
  ).toBe(201);
  return {
    sessionId: session.sessionId!,
    viewportTransport: session.viewportTransport,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Median gap between consecutive arrivals, in ms. */
function medianGap(times: number[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i += 1)
    gaps.push(times[i]! - times[i - 1]!);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? Number.POSITIVE_INFINITY;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[index] ?? 0);
}

test.describe("WebMCP viewport frame stream", () => {
  test.skip(
    !LOCAL_TARGET,
    "The WebMCP Inspector is not mounted on a hosted deployment.",
  );
  // Serial, because each test opens a real browser and the registry caps
  // concurrent sessions at two — parallel workers would race each other into a
  // capacity refusal that has nothing to do with what is under test.
  test.describe.configure({ mode: "serial" });
  // A real browser launch plus a live screencast; the default 30s is tight.
  test.setTimeout(120_000);

  test("streams real frames over the binary socket, off the SSE stream", async () => {
    const page = await startWebMcpFixturePage();
    const token = await sessionToken();
    let sessionId: string | undefined;
    let socket: ReturnType<typeof openFrameSocket> | undefined;

    try {
      const created = await fetch(`${BASE}/api/mcp/webmcp/sessions`, {
        method: "POST",
        headers: authed(token, { "content-type": "application/json" }),
        body: JSON.stringify({ url: page.url, display: "in-app" }),
      });
      const session = (await created.json()) as {
        sessionId?: string;
        viewportTransport?: { kind?: string; width?: number; height?: number };
        error?: string;
      };
      expect(
        created.status,
        `session start failed: ${JSON.stringify(session)}`,
      ).toBe(201);
      sessionId = session.sessionId!;
      // An in-app session is the only one with pixels to carry, and it says so
      // on the wire — which is exactly what the client keys its transport
      // choice off.
      expect(session.viewportTransport?.kind).toBe("frame-stream");

      socket = openFrameSocket(token, sessionId);
      await socket.opened;

      await command(token, sessionId, {
        type: "set_screencast",
        enabled: true,
      });
      await expect
        .poll(() => socket!.frames.length, {
          message: "frames should arrive on the binary socket",
          timeout: 20_000,
        })
        .toBeGreaterThan(2);

      // ---- the wire itself -------------------------------------------------
      const first = socket.frames[0]!;
      // Every message decoded: a single undecodable one means the header the
      // route writes and the header the client reads have drifted.
      expect(socket.undecodable).toEqual([]);
      expect(first.deviceWidth).toBe(session.viewportTransport!.width);
      expect(first.deviceHeight).toBe(session.viewportTransport!.height);
      // A real JPEG, not a base64 string that happened to survive the trip.
      expect([first.jpeg[0], first.jpeg[1]]).toEqual([0xff, 0xd8]);
      expect(first.jpeg.byteLength).toBeGreaterThan(1_000);
      // The session's own counter, strictly increasing — the property the
      // client's seq guard is built on.
      const seqs = socket.frames.map((frame) => frame.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);

      // ---- SSE carries everything BUT the frames --------------------------
      const suppressed = await readSse(
        token,
        sessionId,
        "replay=200&frames=off",
        1_500,
      );
      expect(suppressed).toContain("session_started");
      expect(suppressed).not.toContain('"type":"frame"');

      // …and still does carry them for a client that never asked to opt out,
      // which is every client older than this socket.
      const withFrames = await readSse(token, sessionId, "replay=200", 1_500);
      expect(withFrames).toContain('"type":"frame"');

      // ---- capture → arrival ----------------------------------------------
      const latencies = socket.frames.map(
        (frame) => frame.receivedAt - frame.ts,
      );
      // Fewer than two arrivals has no period to speak of, and `medianGap`
      // answers Infinity there — which would make the bound below pass on a
      // stream that never ran.
      expect(
        socket.frames.length,
        "frames to measure a period from",
      ).toBeGreaterThan(1);
      const period = medianGap(socket.frames.map((frame) => frame.receivedAt));
      console.log(
        `[frame-stream] capture→arrival over ${latencies.length} frames: ` +
          `p50 ${percentile(latencies, 50)}ms, p95 ${percentile(latencies, 95)}ms ` +
          `(frame period ${period}ms)`,
      );
      // Bounded against a baseline from the SAME run, for the reason the rate
      // test gives: an absolute cap here is a claim about the hardware. Loose
      // enough not to redden a parked runner, it would also pass the 10-20x
      // regression this number exists to catch; tight enough to catch that,
      // it reddens the runner.
      //
      // The pairing that survives both is the frame period itself. `ts` is
      // stamped when a capture reaches the provider, BEFORE the throttle, so
      // this latency is the throttle's hold plus encode, transport and decode
      // — and a stream that is keeping up delivers a frame in less time than
      // it takes to produce the next one. Past that it is backing up,
      // whatever the box. Medians on both sides, so one stalled frame moves
      // neither. On this machine the ratio is ~0.1; the bound is 1.
      expect(percentile(latencies, 50)).toBeLessThan(period);
    } finally {
      socket?.close();
      if (sessionId) {
        await fetch(`${BASE}/api/mcp/webmcp/sessions/${sessionId}`, {
          method: "DELETE",
          headers: authed(token),
        }).catch(() => {});
      }
      await page.close();
    }
  });

  test("raises the frame rate while input is arriving, and settles after", async () => {
    const page = await startWebMcpFixturePage();
    const token = await sessionToken();
    let sessionId: string | undefined;
    let socket: ReturnType<typeof openFrameSocket> | undefined;

    try {
      const created = await fetch(`${BASE}/api/mcp/webmcp/sessions`, {
        method: "POST",
        headers: authed(token, { "content-type": "application/json" }),
        body: JSON.stringify({ url: page.url, display: "in-app" }),
      });
      const session = (await created.json()) as { sessionId?: string };
      expect(created.status).toBe(201);
      sessionId = session.sessionId!;

      socket = openFrameSocket(token, sessionId);
      await socket.opened;
      await command(token, sessionId, {
        type: "set_screencast",
        enabled: true,
      });
      await expect
        .poll(() => socket!.frames.length, { timeout: 20_000 })
        .toBeGreaterThan(1);

      // ---- resting rate ---------------------------------------------------
      socket.frames.length = 0;
      await sleep(2_500);
      // Asserted before the median: `medianGap` answers Infinity for fewer
      // than two arrivals, and `Infinity > floor` is true — so a stream that
      // delivered nothing at all would sail through the cadence bound below.
      expect(socket.frames.length, "resting frames").toBeGreaterThan(1);
      const restingGap = medianGap(socket.frames.map((f) => f.receivedAt));
      console.log(
        `[frame-stream] resting: ${socket.frames.length} frames, median gap ${restingGap}ms`,
      );
      // The fixture repaints every animation frame, so the stream is saturated
      // and the gap is the floor rather than the page's own cadence.
      expect(restingGap).toBeGreaterThan(WEBMCP_FRAME_MIN_INTERVAL_MS * 0.7);

      // ---- driven rate ----------------------------------------------------
      socket.frames.length = 0;
      const drivenFor = 2_000;
      const until = Date.now() + drivenFor;
      while (Date.now() < until) {
        await command(token, sessionId, {
          type: "input",
          events: [{ kind: "wheel", x: 400, y: 300, deltaX: 0, deltaY: 120 }],
        });
        await sleep(120);
      }
      expect(socket.frames.length, "driven frames").toBeGreaterThan(1);
      const drivenGap = medianGap(socket.frames.map((f) => f.receivedAt));
      console.log(
        `[frame-stream] driven: ${socket.frames.length} frames, median gap ${drivenGap}ms`,
      );
      // Measured against THIS run's own resting gap rather than an absolute
      // number. Both figures come from the same machine seconds apart, so a
      // loaded runner inflates them together — which makes the ratio a claim
      // about the boost and an absolute threshold a claim about the hardware.
      expect(drivenGap).toBeLessThan(restingGap * 0.7);
      // And a floor, so a stream that simply broke into a flood cannot pass:
      // the boosted interval is a floor, not a target.
      expect(drivenGap).toBeGreaterThanOrEqual(
        WEBMCP_FRAME_BOOST_INTERVAL_MS * 0.5,
      );
      expect(socket.frames.length).toBeGreaterThan(
        Math.floor(drivenFor / WEBMCP_FRAME_MIN_INTERVAL_MS),
      );

      // ---- and it decays --------------------------------------------------
      await sleep(2_000);
      socket.frames.length = 0;
      await sleep(2_000);
      // Same reason as the resting sample: a stream that stopped entirely
      // would otherwise read as "back at the resting floor".
      expect(socket.frames.length, "settled frames").toBeGreaterThan(1);
      const settledGap = medianGap(socket.frames.map((f) => f.receivedAt));
      console.log(
        `[frame-stream] settled: ${socket.frames.length} frames, median gap ${settledGap}ms`,
      );
      // The boost is paid for exactly while it buys something: a page nobody is
      // touching is back at the resting floor. Compared to the driven gap for
      // the same reason as above — the claim is that it went back up.
      expect(settledGap).toBeGreaterThan(WEBMCP_FRAME_MIN_INTERVAL_MS * 0.7);
      expect(settledGap).toBeGreaterThan(drivenGap * 1.5);
    } finally {
      socket?.close();
      if (sessionId) {
        await fetch(`${BASE}/api/mcp/webmcp/sessions/${sessionId}`, {
          method: "DELETE",
          headers: authed(token),
        }).catch(() => {});
      }
      await page.close();
    }
  });

  test("sharpens the picture once the page stops painting", async () => {
    // The whole chain for the settle still: a real screencast, a page that
    // stops, a capture the server takes on its own, and the pane's transport
    // carrying it. What the unit suites cannot show is that the still SURVIVES
    // the round trip — Chromium answers every capture with a repaint of the
    // same picture, and publishing that would undo the sharpening a tenth of a
    // second later.
    const page = await startWebMcpFixturePage({ variant: "static" });
    const token = await sessionToken();
    let sessionId: string | undefined;
    let socket: ReturnType<typeof openFrameSocket> | undefined;

    try {
      const session = await openSession(token, {
        url: page.url,
        display: "in-app",
      });
      sessionId = session.sessionId;
      socket = openFrameSocket(token, sessionId);
      await socket.opened;
      await command(token, sessionId, {
        type: "set_screencast",
        enabled: true,
      });

      await expect
        .poll(() => socket!.frames.length, { timeout: 20_000 })
        .toBeGreaterThan(0);
      // Let the page finish loading and settle once, so what follows is not
      // measuring the difference between a half-painted page and a whole one.
      await sleep(WEBMCP_SETTLE_QUIET_MS + 2_500);

      // Scroll, which is the gesture this whole trade is about: motion the
      // stream carries at its own quality, and then a page at rest showing
      // text somebody is going to read.
      await command(token, sessionId, {
        type: "input",
        events: [{ kind: "wheel", x: 400, y: 300, deltaX: 0, deltaY: 400 }],
      });
      await expect
        .poll(() => socket!.frames.length, { timeout: 10_000 })
        .toBeGreaterThan(0);
      await sleep(500);
      const streamedCount = socket.frames.length;
      const streamed = socket.frames.at(-1)!;

      // The fixture never repaints on its own, so anything arriving now is the
      // still — or the repaint Chromium produces to satisfy the capture, which
      // is dropped as redundant before it reaches this socket.
      await sleep(WEBMCP_SETTLE_QUIET_MS + 2_500);
      expect(
        socket.frames.length,
        "a still after the page settled",
      ).toBeGreaterThan(streamedCount);

      // The same scrolled page, in more bytes. Taken as the largest frame that
      // arrived after it settled rather than as the last one, so a build that
      // answers a capture with one extra repaint does not turn this into a
      // flake — what must hold is that the sharp still got through.
      const settled = socket.frames.slice(streamedCount);
      const sharpest = Math.max(...settled.map((f) => f.jpeg.byteLength));
      expect(sharpest).toBeGreaterThan(streamed.jpeg.byteLength);
      expect(sharpest).toBeLessThanOrEqual(WEBMCP_FRAME_MAX_BYTES);

      // And the stream then goes quiet. A still induces a repaint, and a
      // repaint counted as activity would take another still, and another —
      // so this is the assertion that pins the loop shut. One stray frame is
      // tolerated; a loop delivers one per second.
      const after = socket.frames.length;
      await sleep(3_000);
      expect(socket.frames.length - after, "no capture loop").toBeLessThan(2);
    } finally {
      socket?.close();
      if (sessionId) {
        await fetch(`${BASE}/api/mcp/webmcp/sessions/${sessionId}`, {
          method: "DELETE",
          headers: authed(token),
        }).catch(() => {});
      }
      await page.close();
    }
  });

  test("captures at the client's device pixel ratio", async () => {
    const page = await startWebMcpFixturePage();
    const token = await sessionToken();
    let sessionId: string | undefined;
    let socket: ReturnType<typeof openFrameSocket> | undefined;

    try {
      const session = await openSession(token, {
        url: page.url,
        display: "in-app",
        devicePixelRatio: 2,
      });
      sessionId = session.sessionId;
      socket = openFrameSocket(token, sessionId);
      await socket.opened;
      await command(token, sessionId, {
        type: "set_screencast",
        enabled: true,
      });
      await expect
        .poll(() => socket!.frames.length, { timeout: 20_000 })
        .toBeGreaterThan(1);

      const cssWidth = session.viewportTransport!.width!;

      // THE assertion that only holds if the ratio actually took effect. Every
      // geometry check below is self-consistent at any ratio — Chromium clamps
      // the screencast to the CSS surface size, so a server that silently
      // dropped the field would produce identical frames — and the only place
      // the ratio IS visible is inside the page that was rendered with it.
      const reported = toolJson(
        await invokePageTool(token, sessionId, "viewport_report"),
      );
      expect(reported.devicePixelRatio).toBe(2);
      // …and the page's own CSS size is unchanged by it, which is what makes
      // the coordinates the client sends back still mean what the page thinks.
      expect(reported.innerWidth).toBe(cssWidth);

      for (const frame of socket.frames) {
        expect([frame.jpeg[0], frame.jpeg[1]]).toEqual([0xff, 0xd8]);
        expect(frame.jpeg.byteLength).toBeLessThanOrEqual(
          WEBMCP_FRAME_MAX_BYTES,
        );
        // NOT a pixel count. Chromium clamps a screencast to the CSS size of
        // the surface — `maxWidth` can only scale a capture DOWN — so a 2x
        // session streams supersampled 1280x800 rather than 2560x1600, and a
        // test that demanded the latter would be asserting a wish.
        //
        // What must hold on any build and at any ratio is that a frame's
        // reported geometry matches the picture inside it and its scale is the
        // ratio to the page's own coordinate space: that is what every click
        // is divided by, and the difference between a sharper pane and clicks
        // landing at double their coordinates.
        const sof = readJpegDimensions(frame.jpeg);
        expect(sof, "every frame is a decodable JPEG").toBeDefined();
        expect(frame.deviceWidth).toBe(sof!.width);
        expect(frame.deviceHeight).toBe(sof!.height);
        expect(frame.scale ?? 1).toBeCloseTo(sof!.width / cssWidth, 2);
      }
      // Through Playwright's own reporting rather than `console.log`: this is
      // what a build actually handed over, and it belongs in the report beside
      // the result rather than in the job's stdout.
      test.info().annotations.push({
        type: "frame-geometry",
        description:
          `dpr 2: ${socket.frames[0]!.deviceWidth}x` +
          `${socket.frames[0]!.deviceHeight} at scale ${socket.frames[0]!.scale}`,
      });
    } finally {
      socket?.close();
      if (sessionId) {
        await fetch(`${BASE}/api/mcp/webmcp/sessions/${sessionId}`, {
          method: "DELETE",
          headers: authed(token),
        }).catch(() => {});
      }
      await page.close();
    }
  });

  test("steps quality down on a slow consumer, and back up after", async () => {
    test.slow();
    // The `busy` fixture repaints an incompressible mosaic, so frames are
    // large but still under the cap: the pressure this measures comes from a
    // socket that stopped draining, not from frames the provider had to drop
    // for being oversized.
    const page = await startWebMcpFixturePage({ variant: "busy" });
    const token = await sessionToken();
    let sessionId: string | undefined;
    let socket: ReturnType<typeof openFrameSocket> | undefined;
    let paused = false;

    try {
      const session = await openSession(token, {
        url: page.url,
        display: "in-app",
      });
      sessionId = session.sessionId;
      socket = openFrameSocket(token, sessionId);
      await socket.opened;
      await command(token, sessionId, {
        type: "set_screencast",
        enabled: true,
      });
      await expect
        .poll(() => socket!.frames.length, { timeout: 20_000 })
        .toBeGreaterThan(2);
      for (const frame of socket.frames) {
        expect(frame.jpeg.byteLength).toBeLessThanOrEqual(
          WEBMCP_FRAME_MAX_BYTES,
        );
      }

      // Stop reading. Writes keep succeeding until the kernel buffers fill,
      // which is exactly the shape of a viewer on a tunnel or a remote dev box
      // — the case this whole mechanism exists for.
      (socket.ws as unknown as { _socket: { pause(): void } })._socket.pause();
      paused = true;
      await expect
        .poll(
          async () =>
            latestStreamQuality(
              await readSse(token, sessionId!, "replay=200&frames=off", 800),
            ) ?? WEBMCP_STREAM_QUALITY_LADDER[0],
          {
            message: "the stream should step down for a consumer that stalled",
            timeout: 45_000,
          },
        )
        .toBeLessThan(WEBMCP_STREAM_QUALITY_LADDER[0]);

      // Read again, and the picture comes back. Asserted as a floor rather
      // than an exact rung: the governor keeps stepping while the socket is
      // paused, so how far down it got is a property of the machine.
      (
        socket.ws as unknown as { _socket: { resume(): void } }
      )._socket.resume();
      paused = false;
      const beforeResume = socket.frames.length;
      await expect
        .poll(() => socket!.frames.length, { timeout: 20_000 })
        .toBeGreaterThan(beforeResume + 2);
      await expect
        .poll(
          async () =>
            latestStreamQuality(
              await readSse(token, sessionId!, "replay=200&frames=off", 800),
            ) ?? 0,
          {
            message: "the stream should climb back once the link recovers",
            timeout: 45_000,
          },
        )
        .toBe(WEBMCP_STREAM_QUALITY_LADDER[0]);
    } finally {
      if (paused && socket) {
        // Before the close, or the teardown blocks on a socket nobody is
        // reading and the DELETE below never goes out.
        (
          socket.ws as unknown as { _socket: { resume(): void } }
        )._socket.resume();
      }
      socket?.close();
      if (sessionId) {
        await fetch(`${BASE}/api/mcp/webmcp/sessions/${sessionId}`, {
          method: "DELETE",
          headers: authed(token),
        }).catch(() => {});
      }
      await page.close();
    }
  });

  test("refuses a frame socket without a valid token", async () => {
    const token = await sessionToken();
    const page = await startWebMcpFixturePage();
    let sessionId: string | undefined;
    try {
      const created = await fetch(`${BASE}/api/mcp/webmcp/sessions`, {
        method: "POST",
        headers: authed(token, { "content-type": "application/json" }),
        body: JSON.stringify({ url: page.url, display: "in-app" }),
      });
      const session = (await created.json()) as { sessionId?: string };
      expect(created.status).toBe(201);
      sessionId = session.sessionId!;

      const closed = (ws: WebSocket) =>
        new Promise<number>((resolve) => {
          ws.on("error", () => {});
          ws.on("close", (code) => resolve(code));
        });

      const url = `${BASE.replace(/^http/, "ws")}/api/web/webmcp/sessions/${sessionId}/frames`;
      // The token IS the auth on this route: it is reachable without the
      // session-auth middleware, so a wrong token has to be refused here.
      expect(
        await closed(new WebSocket(url, ["not-the-token"], { origin: ORIGIN })),
      ).toBe(4401);
      // Browsers always send an Origin on a handshake; a client without one has
      // no business opening this.
      expect(await closed(new WebSocket(url, [token]))).toBe(4401);
      // A session that does not exist is 4404, which the client's ladder reads
      // as terminal rather than retryable.
      expect(
        await closed(
          new WebSocket(
            `${BASE.replace(/^http/, "ws")}/api/web/webmcp/sessions/nope/frames`,
            [token],
            { origin: ORIGIN },
          ),
        ),
      ).toBe(4404);
    } finally {
      if (sessionId) {
        await fetch(`${BASE}/api/mcp/webmcp/sessions/${sessionId}`, {
          method: "DELETE",
          headers: authed(token),
        }).catch(() => {});
      }
      await page.close();
    }
  });
});
