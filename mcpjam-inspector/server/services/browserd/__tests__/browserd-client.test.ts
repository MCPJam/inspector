import { describe, expect, it } from "vitest";
import { BrowserdClient, BrowserdClientError } from "../browserd-client";
import type { BrowserCommand } from "../protocol";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stub(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const CMD: BrowserCommand = {
  commandId: "c1",
  source: "chat",
  action: { kind: "navigate", url: "https://x.test/" },
};

function makeClient(response: Response, over: { baseUrl?: string } = {}) {
  const s = stub(response);
  return {
    ...s,
    client: new BrowserdClient({
      baseUrl: over.baseUrl ?? "https://box-8791.e2b.dev",
      bearer: "boot-bearer",
      fetchImpl: s.fetchImpl,
    }),
  };
}

describe("BrowserdClient.sendCommand", () => {
  it("maps 200 to ok, authenticates, and sends {command, expectedBootId}", async () => {
    const { client, calls } = makeClient(
      json(200, {
        status: "ok",
        result: { ok: true, output: { url: "https://x.test/" } },
        bootId: "boot-1",
      }),
    );
    const res = await client.sendCommand(CMD, "boot-1");
    expect(res).toEqual({
      status: "ok",
      result: { ok: true, output: { url: "https://x.test/" } },
      bootId: "boot-1",
    });
    const { url, init } = calls[0];
    expect(url).toBe("https://box-8791.e2b.dev/v1/commands");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer boot-bearer",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      command: CMD,
      expectedBootId: "boot-1",
    });
  });

  it("maps 429 → busy, 503 → at_capacity", async () => {
    expect(
      await makeClient(
        json(429, { status: "busy", bootId: "b" }),
      ).client.sendCommand(CMD),
    ).toEqual({ status: "busy", bootId: "b" });
    expect(
      await makeClient(
        json(503, { error: "daemon_at_capacity", bootId: "b" }),
      ).client.sendCommand(CMD),
    ).toEqual({ status: "at_capacity", bootId: "b" });
  });

  it("distinguishes the three 409 rejections by body.error", async () => {
    expect(
      await makeClient(
        json(409, { error: "command_expired", bootId: "b" }),
      ).client.sendCommand(CMD),
    ).toEqual({ status: "expired", bootId: "b" });
    expect(
      await makeClient(
        json(409, { error: "command_unknown_boot", bootId: "b" }),
      ).client.sendCommand(CMD),
    ).toEqual({ status: "unknown_boot", bootId: "b" });
    const stale = await makeClient(
      json(409, {
        error: "stale_observation",
        result: { ok: false, staleObservation: true },
        bootId: "b",
      }),
    ).client.sendCommand(CMD);
    expect(stale).toMatchObject({
      status: "stale_observation",
      result: { staleObservation: true },
      bootId: "b",
    });
  });

  it("throws on an uninterpretable status (401/400 = a wiring bug, not a signal)", async () => {
    await expect(
      makeClient(json(401, {})).client.sendCommand(CMD),
    ).rejects.toBeInstanceOf(BrowserdClientError);
    await expect(
      makeClient(json(400, { error: "invalid_command" })).client.sendCommand(
        CMD,
      ),
    ).rejects.toThrow(/HTTP 400.*invalid_command/);
  });
});

describe("BrowserdClient.health", () => {
  it("reports ok on 200 and does NOT authenticate healthz", async () => {
    const { client, calls } = makeClient(json(200, { ok: true }));
    expect(await client.health()).toEqual({ ok: true, detail: undefined });
    expect(calls[0].url).toBe("https://box-8791.e2b.dev/healthz");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBeNull();
  });

  it("reports a dead browser (503) with its detail", async () => {
    const { client } = makeClient(
      json(503, { ok: false, detail: "chromium exited" }),
    );
    expect(await client.health()).toEqual({
      ok: false,
      detail: "chromium exited",
    });
  });
});

describe("BrowserdClient base URL", () => {
  it("normalises a trailing slash so paths never double up", async () => {
    const { client, calls } = makeClient(json(200, { ok: true }), {
      baseUrl: "https://box-8791.e2b.dev/",
    });
    await client.health();
    expect(calls[0].url).toBe("https://box-8791.e2b.dev/healthz");
  });
});

describe("BrowserdClient.sendInput", () => {
  const EVENTS = [
    { type: "mouse_move" as const, x: 10, y: 20 },
    { type: "text" as const, text: "hunter2" },
  ];

  it("posts the batch to /v1/input under the boot bearer", async () => {
    const { client, calls } = makeClient(
      json(200, { ok: true, bootId: "boot-1" }),
    );
    expect(
      await client.sendInput({
        holder: "users_1",
        events: EVENTS,
        tabId: "tab-2",
      }),
    ).toEqual({ ok: true });

    expect(calls[0]!.url).toBe("https://box-8791.e2b.dev/v1/input");
    expect(calls[0]!.init.method).toBe("POST");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
      "Bearer boot-bearer",
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      holder: "users_1",
      events: EVENTS,
      tabId: "tab-2",
    });
  });

  it("omits tabId rather than sending it as null", async () => {
    // The daemon reads `typeof tabId === "string"`, so a null would be ignored
    // — but it would also be the first thing to read as "this pane asked for a
    // tab" if that check ever loosened.
    const { client, calls } = makeClient(json(200, { ok: true }));
    await client.sendInput({ holder: "users_1", events: EVENTS });
    expect(JSON.parse(String(calls[0]!.init.body))).not.toHaveProperty("tabId");
  });

  it("REPORTS a lease refusal rather than throwing it", async () => {
    // 423 is the ordinary answer while the agent is driving. A client that
    // threw here would make a pane show an error about a browser that is
    // working exactly as designed — and would do it on every keystroke.
    const { client } = makeClient(
      json(423, { error: "lease_held", bootId: "boot-1" }),
    );
    expect(
      await client.sendInput({ holder: "users_1", events: EVENTS }),
    ).toEqual({ ok: false, status: 423, error: "lease_held" });
  });

  it("carries the daemon's own reason for 404 and 413", async () => {
    for (const [status, error] of [
      [404, "unknown_tab"],
      [413, "too_many_events"],
    ] as const) {
      const { client } = makeClient(json(status, { error }));
      expect(
        await client.sendInput({ holder: "users_1", events: EVENTS }),
      ).toEqual({ ok: false, status, error });
    }
  });

  it("falls back to the status when the body says nothing", async () => {
    const { client } = makeClient(
      new Response("upstream is unwell", { status: 502 }),
    );
    expect(
      await client.sendInput({ holder: "users_1", events: EVENTS }),
    ).toEqual({
      ok: false,
      status: 502,
      error: "http_502",
    });
  });
});

describe("BrowserdClient — what it refuses to do at all", () => {
  it("will not put the boot bearer on a cleartext hop", async () => {
    // The bearer is full control of somebody's browser: commands, input, and a
    // live stream of whatever is on the page. The origin comes from a
    // control-plane row validated as a non-empty string and nothing more, so
    // this is the one place that can insist on the scheme — and it has to
    // refuse rather than downgrade, since a client that quietly spoke
    // cleartext would leak the credential on every single call.
    expect(
      () =>
        new BrowserdClient({
          baseUrl: "http://box-8791.e2b.dev",
          bearer: "boot-bearer",
        }),
    ).toThrow(/https/i);
    // Not even loopback: nothing constructs this against a local daemon — the
    // local engine speaks to an in-process client — so an exemption would be a
    // hole with no caller behind it.
    expect(
      () =>
        new BrowserdClient({ baseUrl: "http://127.0.0.1:8791", bearer: "b" }),
    ).toThrow(/https/i);
    expect(
      () => new BrowserdClient({ baseUrl: "https://box.example", bearer: "b" }),
    ).not.toThrow();
  });
});

/**
 * R-3. Recording control over the wire.
 *
 * A RESULT rather than a throw on every refusal: a box with no ffmpeg (503)
 * and a box already recording (409) are ordinary states of a run, and a caller
 * that surfaced either as a failure would be reporting a run working exactly
 * as designed.
 */
describe("BrowserdClient — /v1/record", () => {
  it("sends a start with the id and fps it was given", async () => {
    const { client, calls } = makeClient(json(200, { ok: true, id: "run-1", fps: 15 }));

    expect(await client.record({ action: "start", id: "run-1", fps: 15 })).toEqual({
      ok: true,
    });
    expect(calls[0]!.url).toBe("https://box-8791.e2b.dev/v1/record");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      action: "start",
      id: "run-1",
      fps: 15,
    });
    expect(
      new Headers(calls[0]!.init.headers).get("authorization"),
    ).toBe("Bearer boot-bearer");
  });

  it("omits fps entirely rather than sending a guess", async () => {
    // The daemon owns the default (15). Sending `undefined` would serialize to
    // a missing key anyway, but sending a NUMBER here would mean two places
    // decide the rate and only one of them is tested.
    const { client, calls } = makeClient(json(200, { ok: true }));
    await client.record({ action: "start", id: "run-1" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      action: "start",
      id: "run-1",
    });
  });

  it("reads a finished take back off a stop", async () => {
    const recording = {
      path: "/rec/run-1.mp4",
      bytes: 1_234,
      durationMs: 9_000,
      distinctFrames: 42,
      truncated: true,
    };
    const { client, calls } = makeClient(json(200, { ok: true, recording }));

    expect(await client.record({ action: "stop" })).toEqual({
      ok: true,
      recording,
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ action: "stop" });
  });

  it("reads `nothing was recording` as an answer, not an error", async () => {
    const { client } = makeClient(json(200, { ok: true, recording: null }));
    expect(await client.record({ action: "stop" })).toEqual({
      ok: true,
      recording: null,
    });
  });

  it("refuses a half-decoded recording rather than inventing its fields", async () => {
    // EVERY field, or none. Defaulting a missing `durationMs` to 0 and a
    // missing `truncated` to false does not degrade gracefully — it invents
    // the two claims a reader most relies on, and they travel into the trace
    // page as a stated duration and an absent badge. "This take completed and
    // ran for no time" is a worse answer than "I could not read that".
    const complete = {
      path: "/rec/run-1.mp4",
      bytes: 5,
      durationMs: 9_000,
      distinctFrames: 42,
      truncated: false,
    };
    for (const missing of [
      "path",
      "bytes",
      "durationMs",
      "distinctFrames",
      "truncated",
    ] as const) {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[missing];
      const { client } = makeClient(
        json(200, { ok: true, recording: partial }),
      );
      expect(
        await client.record({ action: "stop" }),
        `missing ${missing}`,
      ).toEqual({ ok: true, recording: null });
    }
    // ...and the complete one still reads back whole.
    const whole = makeClient(json(200, { ok: true, recording: complete }));
    expect(await whole.client.record({ action: "stop" })).toEqual({
      ok: true,
      recording: complete,
    });
  });

  it("maps 409 and 503 to results the caller can read", async () => {
    const active = makeClient(json(409, { error: "record_active" }));
    expect(await active.client.record({ action: "start", id: "run-2" })).toEqual({
      ok: false,
      status: 409,
      error: "record_active",
    });

    const missing = makeClient(json(503, { error: "record_unavailable" }));
    expect(await missing.client.record({ action: "start", id: "run-1" })).toEqual({
      ok: false,
      status: 503,
      error: "record_unavailable",
    });
  });

  it("falls back to the bare status when the daemon sent no code", async () => {
    const { client } = makeClient(new Response("", { status: 502 }));
    expect(await client.record({ action: "start", id: "run-1" })).toEqual({
      ok: false,
      status: 502,
      error: "http_502",
    });
  });

  it("reports the current take on recordStatus, and nothing on a refusal", async () => {
    const live = makeClient(
      json(200, { active: true, id: "run-1", fps: 15, distinctFrames: 7 }),
    );
    expect(await live.client.recordStatus()).toEqual({
      active: true,
      id: "run-1",
      fps: 15,
      distinctFrames: 7,
    });
    expect(live.calls[0]!.init.method).toBe("GET");

    const refused = makeClient(json(503, { error: "record_unavailable" }));
    expect(await refused.client.recordStatus()).toEqual({ active: false });
  });
});
