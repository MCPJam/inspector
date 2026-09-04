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
