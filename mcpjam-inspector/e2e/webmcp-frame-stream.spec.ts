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
  WEBMCP_FRAME_MIN_INTERVAL_MS,
  type WebMcpBinaryFrame,
} from "../shared/webmcp-inspector-protocol";
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
      console.log(
        `[frame-stream] capture→arrival over ${latencies.length} frames: ` +
          `p50 ${percentile(latencies, 50)}ms, p95 ${percentile(latencies, 95)}ms`,
      );
      // Loopback, same machine, same clock. A frame taking longer than this to
      // travel would mean the encode/transport path had regressed by an order
      // of magnitude, not that the machine was busy.
      expect(percentile(latencies, 95)).toBeLessThan(250);
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
