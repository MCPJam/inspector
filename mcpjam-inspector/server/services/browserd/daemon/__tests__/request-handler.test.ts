import { describe, expect, it, vi } from "vitest";
import {
  BrowserdRequestHandler,
  type DaemonRequest,
} from "../request-handler";
import { HandoffLease } from "../lease";
import {
  BROWSERD_PROTOCOL_VERSION,
  type BrowserCommand,
  type BrowserCommandOutcome,
} from "../../protocol";

const TOKEN = "s3cr3t-per-boot-token";
const BOOT = "boot-abc";

function makeHandler(over: {
  outcome?: BrowserCommandOutcome;
  submit?: (c: BrowserCommand) => Promise<BrowserCommandOutcome>;
  health?: () => Promise<{ ok: boolean; detail?: string }>;
  lease?: HandoffLease;
  setVideoTier?: (tier: "auto" | "sharp" | "saver") => void;
  viewport?: (tabId?: string) => Promise<unknown>;
  viewportIfWatched?: (tabId?: string) => unknown;
  recorder?: unknown;
} = {}) {
  const submit: (c: BrowserCommand) => Promise<BrowserCommandOutcome> =
    over.submit ??
    vi.fn(
      async (_c: BrowserCommand): Promise<BrowserCommandOutcome> =>
        over.outcome ?? { status: "ok", result: { ok: true }, bootId: BOOT },
    );
  const health = over.health ?? (async () => ({ ok: true as const }));
  const lease = over.lease ?? new HandoffLease();
  const handler = new BrowserdRequestHandler({
    queue: { submit },
    driver: {
      health,
      ...(over.viewport ? { viewport: over.viewport as never } : {}),
      ...(over.viewportIfWatched
        ? { viewportIfWatched: over.viewportIfWatched as never }
        : {}),
    },
    bootId: BOOT,
    token: TOKEN,
    lease,
    ...(over.setVideoTier ? { setVideoTier: over.setVideoTier } : {}),
    ...(over.recorder ? { recorder: over.recorder as never } : {}),
  });
  return { handler, submit, lease };
}

function req(over: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    method: "POST",
    path: "/v1/commands",
    origin: undefined,
    authorization: `Bearer ${TOKEN}`,
    body: JSON.stringify({
      command: { commandId: "c1", source: "chat", action: { kind: "reload" } },
    }),
    ...over,
  };
}

describe("BrowserdRequestHandler — health", () => {
  it("answers /healthz unauthenticated with no secrets", async () => {
    const { handler } = makeHandler();
    const res = await handler.handle({
      method: "GET",
      path: "/healthz",
      origin: undefined,
      authorization: undefined,
      body: "",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // never leaks the token or the bootId
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(JSON.stringify(res.body)).not.toContain(BOOT);
  });

  it("reports a dead browser as 503 so the supervisor relaunches", async () => {
    const { handler } = makeHandler({
      health: async () => ({ ok: false, detail: "chromium exited" }),
    });
    const res = await handler.handle({
      method: "GET",
      path: "/healthz",
      origin: undefined,
      authorization: undefined,
      body: "",
    });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, detail: "chromium exited" });
  });

  it("405s a non-GET /healthz", async () => {
    const { handler } = makeHandler();
    const res = await handler.handle(req({ method: "POST", path: "/healthz" }));
    expect(res.status).toBe(405);
  });
});

describe("BrowserdRequestHandler — auth & routing", () => {
  it("401s a request with no bearer", async () => {
    const { handler, submit } = makeHandler();
    const res = await handler.handle(req({ authorization: undefined }));
    expect(res.status).toBe(401);
    expect(submit).not.toHaveBeenCalled();
  });

  it("401s a request with the wrong bearer", async () => {
    const { handler } = makeHandler();
    const res = await handler.handle(req({ authorization: "Bearer nope" }));
    expect(res.status).toBe(401);
  });

  it("403s any request that carries an Origin (rebinding defence)", async () => {
    const { handler, submit } = makeHandler();
    const res = await handler.handle(req({ origin: "https://evil.test" }));
    expect(res.status).toBe(403);
    expect(submit).not.toHaveBeenCalled();
  });

  it("404s an unknown authenticated path", async () => {
    const { handler } = makeHandler();
    const res = await handler.handle(req({ path: "/v1/nope" }));
    expect(res.status).toBe(404);
  });

  it("405s a non-POST /v1/commands", async () => {
    const { handler } = makeHandler();
    const res = await handler.handle(req({ method: "GET" }));
    expect(res.status).toBe(405);
    expect(res.headers).toMatchObject({ allow: "POST" });
  });
});

describe("BrowserdRequestHandler — command body", () => {
  it("400s malformed JSON", async () => {
    const { handler, submit } = makeHandler();
    const res = await handler.handle(req({ body: "{not json" }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_json" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("400s a body with no valid command envelope", async () => {
    const { handler, submit } = makeHandler();
    const res = await handler.handle(
      req({ body: JSON.stringify({ command: { commandId: "" } }) }),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_command" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("executes a valid command and echoes the bootId", async () => {
    const { handler, submit } = makeHandler();
    const res = await handler.handle(req());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", bootId: BOOT });
    expect(submit).toHaveBeenCalledOnce();
  });
});

describe("BrowserdRequestHandler — bootId staleness", () => {
  it("rejects a command whose expectedBootId is a DIFFERENT boot, without queuing it", async () => {
    const { handler, submit } = makeHandler();
    const res = await handler.handle(
      req({
        body: JSON.stringify({
          command: { commandId: "c1", source: "chat", action: { kind: "reload" } },
          expectedBootId: "boot-OLD",
        }),
      }),
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "command_unknown_boot", bootId: BOOT });
    expect(submit).not.toHaveBeenCalled(); // never re-run across a restart
  });

  it("accepts a command whose expectedBootId matches the current boot", async () => {
    const { handler, submit } = makeHandler();
    const res = await handler.handle(
      req({
        body: JSON.stringify({
          command: { commandId: "c1", source: "chat", action: { kind: "reload" } },
          expectedBootId: BOOT,
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(submit).toHaveBeenCalledOnce();
  });
});

describe("BrowserdRequestHandler — outcome mapping", () => {
  const cases: Array<[BrowserCommandOutcome, number, unknown]> = [
    [{ status: "busy", bootId: BOOT }, 429, { status: "busy", bootId: BOOT }],
    [{ status: "expired", bootId: BOOT }, 409, { error: "command_expired" }],
    [{ status: "at_capacity", bootId: BOOT }, 503, { error: "daemon_at_capacity" }],
  ];
  for (const [outcome, status, body] of cases) {
    it(`maps ${outcome.status} → ${status}`, async () => {
      const { handler } = makeHandler({ outcome });
      const res = await handler.handle(req());
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject(body as object);
    });
  }

  it("maps a stale-observation result (L3) to 409 with the fresh state", async () => {
    const fresh = { tabId: "tab-1", navCounter: 9, urlHash: "u9", domHash: "d9" };
    const { handler } = makeHandler({
      outcome: {
        status: "ok",
        result: { ok: false, staleObservation: true, stateToken: fresh },
        bootId: BOOT,
      },
    });
    const res = await handler.handle(req());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "stale_observation",
      result: { staleObservation: true, stateToken: fresh },
      bootId: BOOT,
    });
  });
});

describe("BrowserdRequestHandler — authenticated /v1/status (W2)", () => {
  const statusReq = (over: Partial<DaemonRequest> = {}): DaemonRequest => ({
    method: "GET",
    path: "/v1/status",
    origin: undefined,
    authorization: `Bearer ${TOKEN}`,
    body: "",
    ...over,
  });

  it("returns liveness AND the bootId to an authenticated caller", async () => {
    const { handler } = makeHandler();
    const res = await handler.handle(statusReq());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, bootId: BOOT });
    // The compatibility fields ride along: what the reuse ladder keys off is
    // the WIRE, and it has to be readable from the same probe that proves the
    // daemon is alive.
    expect(res.body).toMatchObject({
      protocolVersion: BROWSERD_PROTOCOL_VERSION,
      lease: "free",
    });
  });

  it("keeps the bootId out of the unauthenticated healthz, but 401s status without the bearer", async () => {
    const { handler } = makeHandler();
    // /healthz stays secret-free (asserted above); /v1/status is the
    // authenticated counterpart — no bearer, no boot identity.
    const res = await handler.handle(statusReq({ authorization: undefined }));
    expect(res.status).toBe(401);
    expect(res.body).toBeUndefined();
  });

  it("reports a dead browser as 503 with the bootId, so a session row can still be matched", async () => {
    const { handler } = makeHandler({
      health: async () => ({ ok: false, detail: "chromium exited" }),
    });
    const res = await handler.handle(statusReq());
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      ok: false,
      detail: "chromium exited",
      bootId: BOOT,
    });
  });

  it("405s a non-GET /v1/status", async () => {
    const { handler } = makeHandler();
    const res = await handler.handle(statusReq({ method: "POST" }));
    expect(res.status).toBe(405);
  });
});

describe("BrowserdRequestHandler — handoff lease gate (W4)", () => {
  const commandFrom = (source: BrowserCommand["source"], holder?: string) =>
    req({
      body: JSON.stringify({
        command: {
          commandId: "c1",
          source,
          action: { kind: "reload" },
          ...(holder ? { holder } : {}),
        },
      }),
    });

  const heldLease = () => {
    const lease = new HandoffLease();
    lease.acquire("panel-a", 60_000);
    return lease;
  };

  const parkedLease = () => {
    let now = 1_000;
    const lease = new HandoffLease({ now: () => now });
    lease.acquire("panel-a", 30_000);
    now += 30_000;
    return lease;
  };

  for (const source of ["chat", "inspector", "eval"] as const) {
    it(`423s a ${source} command while a person HOLDS the lease`, async () => {
      const { handler, submit } = makeHandler({ lease: heldLease() });
      const res = await handler.handle(commandFrom(source));
      expect(res.status).toBe(423);
      expect(res.body).toMatchObject({
        error: "lease_held",
        holder: "panel-a",
        bootId: BOOT,
      });
      // The refusal happens BEFORE the queue: nothing runs, and nothing
      // observes. A filter downstream would already hold the screenshot.
      expect(submit).not.toHaveBeenCalled();
    });

    it(`423s a ${source} command while the lease is PARKED`, async () => {
      const { handler, submit } = makeHandler({ lease: parkedLease() });
      const res = await handler.handle(commandFrom(source));
      expect(res.status).toBe(423);
      expect(res.body).toMatchObject({
        error: "lease_parked",
        holder: "panel-a",
      });
      expect(submit).not.toHaveBeenCalled();
    });
  }

  it("still runs the person's own `manual` command while they hold it", async () => {
    const { handler, submit } = makeHandler({ lease: heldLease() });
    const res = await handler.handle(commandFrom("manual", "panel-a"));
    expect(res.status).toBe(200);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("still runs the holder's `manual` command while the lease is parked", async () => {
    // Parked is "your time ran out mid-flow", not "you are done" — the person
    // may still be typing a card number. Their own commands keep working.
    const { handler, submit } = makeHandler({ lease: parkedLease() });
    const res = await handler.handle(commandFrom("manual", "panel-a"));
    expect(res.status).toBe(200);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("423s a `manual` command that names NOBODY — the source is not a credential", async () => {
    // The bypass this closes: `manual` is the one source the gate lets past,
    // so anything able to reach the daemon could drive and observe a browser
    // someone is signing into by simply claiming to be them.
    const { handler, submit } = makeHandler({ lease: heldLease() });
    const res = await handler.handle(commandFrom("manual"));
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({ error: "lease_held_by_other" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("423s a `manual` command from someone who is not the holder", async () => {
    const { handler, submit } = makeHandler({ lease: heldLease() });
    const res = await handler.handle(commandFrom("manual", "panel-b"));
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({ error: "lease_held_by_other" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("423s a `manual` command while NOBODY holds the lease", async () => {
    // With the lease free the agent may be mid-turn, and two drivers on one
    // page is the exact thing the lease exists to prevent. Take it first.
    const { handler, submit } = makeHandler();
    const res = await handler.handle(commandFrom("manual", "panel-a"));
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({ error: "lease_required" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("reports WHAT holds the browser, so the pane and the model can say", async () => {
    const lease = new HandoffLease();
    lease.acquire("script-1", 60_000, "script");
    const { handler } = makeHandler({ lease });
    const res = await handler.handle(commandFrom("chat"));
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({
      error: "lease_held",
      holder: "script-1",
      holderKind: "script",
    });
  });

  it("maps a result the lease caught INSIDE the queue to the same 423", async () => {
    // The gate cannot see a command that was already admitted. `guardLease`
    // and the driver's capture permit answer those with `leaseBlocked`, and a
    // caller must read one refusal whichever side of the queue it happened on.
    const lease = heldLease();
    const { handler } = makeHandler({
      lease,
      submit: vi.fn().mockResolvedValue({
        status: "ok",
        bootId: "boot-1",
        result: { ok: false, leaseBlocked: true, error: "lease_held: taken" },
      }),
    });
    const res = await handler.handle(commandFrom("manual", "panel-a"));
    expect(res.status).toBe(423);
    // The ENVELOPE carries the bare code — that is what the client codec
    // matches on — and the prose rides alongside as `detail`.
    expect(res.body).toMatchObject({
      error: "lease_held",
      detail: "lease_held: taken",
      holder: "panel-a",
    });
  });

  it("blocks OBSERVATIONS too — the privacy half of the gate", async () => {
    const { handler, submit } = makeHandler({ lease: heldLease() });
    const res = await handler.handle(
      req({
        body: JSON.stringify({
          command: {
            commandId: "c1",
            source: "chat",
            action: { kind: "observe", modes: ["screenshot", "dom"] },
          },
        }),
      }),
    );
    expect(res.status).toBe(423);
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses before the bootId check, so a stale caller still learns it is locked", async () => {
    // Order matters for the caller's next move: 'someone has the browser' is
    // actionable (wait / ask them), 'wrong boot' would send it re-establishing
    // a session it cannot use anyway.
    const { handler, submit } = makeHandler({ lease: heldLease() });
    const res = await handler.handle(
      req({
        body: JSON.stringify({
          command: { commandId: "c1", source: "chat", action: { kind: "reload" } },
          expectedBootId: "boot-OLD",
        }),
      }),
    );
    expect(res.status).toBe(423);
    expect(submit).not.toHaveBeenCalled();
  });

  it("runs commands again once the holder resumes", async () => {
    const lease = heldLease();
    const { handler, submit } = makeHandler({ lease });
    expect((await handler.handle(commandFrom("chat"))).status).toBe(423);
    lease.resume("panel-a");
    expect((await handler.handle(commandFrom("chat"))).status).toBe(200);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("keeps a malformed body a 400 — the gate never masks a bad envelope", async () => {
    const { handler } = makeHandler({ lease: heldLease() });
    const res = await handler.handle(req({ body: "{not json" }));
    expect(res.status).toBe(400);
  });
});

describe("BrowserdRequestHandler — /v1/lease", () => {
  const leaseReq = (
    body: Record<string, unknown>,
    over: Partial<DaemonRequest> = {},
  ): DaemonRequest =>
    req({ path: "/v1/lease", body: JSON.stringify(body), ...over });

  it("requires the bearer like every other authenticated endpoint", async () => {
    const { handler } = makeHandler();
    const res = await handler.handle(
      leaseReq({ action: "acquire", holder: "panel-a" }, {
        authorization: undefined,
      }),
    );
    expect(res.status).toBe(401);
  });

  it("reads the current state on GET", async () => {
    const { handler, lease } = makeHandler();
    lease.acquire("panel-a", 60_000);
    const res = await handler.handle(
      req({ path: "/v1/lease", method: "GET", body: "" }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      lease: { state: "held", holder: "panel-a" },
      bootId: BOOT,
    });
  });

  it("acquires, heartbeats and resumes for the holder", async () => {
    const { handler } = makeHandler();
    const acquired = await handler.handle(
      leaseReq({ action: "acquire", holder: "panel-a", ttlMs: 60_000 }),
    );
    expect(acquired.status).toBe(200);
    expect(acquired.body).toMatchObject({ lease: { state: "held", holder: "panel-a" } });

    const beat = await handler.handle(
      leaseReq({ action: "heartbeat", holder: "panel-a", ttlMs: 60_000 }),
    );
    expect(beat.status).toBe(200);
    expect(beat.body).toMatchObject({ lease: { state: "held" } });

    const resumed = await handler.handle(
      leaseReq({ action: "resume", holder: "panel-a" }),
    );
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ lease: { state: "free" } });
  });

  it("409s an acquire that did not take, rather than lying to a second tab", async () => {
    // A UI told '200 OK' while someone else holds the browser would show a
    // person a live view of a page the model is still driving.
    const { handler } = makeHandler();
    await handler.handle(leaseReq({ action: "acquire", holder: "panel-a" }));
    const res = await handler.handle(
      leaseReq({ action: "acquire", holder: "panel-b" }),
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ lease: { state: "held", holder: "panel-a" } });
  });

  it("ignores a resume from anyone but the holder", async () => {
    const { handler, lease } = makeHandler();
    await handler.handle(leaseReq({ action: "acquire", holder: "panel-a" }));
    const res = await handler.handle(
      leaseReq({ action: "resume", holder: "panel-b" }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lease: { state: "held", holder: "panel-a" } });
    expect(lease.state().state).toBe("held");
  });

  it("400s a body with no holder, malformed JSON, or an unknown action", async () => {
    const { handler } = makeHandler();
    expect(
      (await handler.handle(leaseReq({ action: "acquire" }))).body,
    ).toMatchObject({ error: "holder_required" });
    expect(
      (await handler.handle(req({ path: "/v1/lease", body: "{nope" }))).body,
    ).toMatchObject({ error: "invalid_json" });
    expect(
      (await handler.handle(leaseReq({ action: "steal", holder: "panel-a" })))
        .body,
    ).toMatchObject({ error: "invalid_lease_action" });
  });

  it("405s an unsupported method", async () => {
    const { handler } = makeHandler();
    const res = await handler.handle(
      req({ path: "/v1/lease", method: "DELETE", body: "" }),
    );
    expect(res.status).toBe(405);
    expect(res.headers).toMatchObject({ allow: "GET, POST" });
  });

  it("stays reachable while the lease itself blocks commands", async () => {
    // Otherwise a person could take the browser and never hand it back.
    const { handler } = makeHandler({ lease: heldLeaseFor("panel-a") });
    const res = await handler.handle(
      leaseReq({ action: "resume", holder: "panel-a" }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lease: { state: "free" } });
  });
});

function heldLeaseFor(holder: string): HandoffLease {
  const lease = new HandoffLease();
  lease.acquire(holder, 60_000);
  return lease;
}

describe("BrowserdRequestHandler — watching and touching the page", () => {
  function makeViewport() {
    const listeners: Array<(f: unknown) => void> = [];
    const dispatched: unknown[][] = [];
    const viewport = {
      subscribe(listener: (f: unknown) => void) {
        listeners.push(listener);
        return () => {
          const i = listeners.indexOf(listener);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      subscriberCount: () => listeners.length,
      // Mirrors the real viewport: the permit is re-asked BEFORE each event,
      // so a batch that spans a handoff stops at the boundary instead of
      // delivering the rest under the new holder.
      async dispatchInput(events: unknown[], stillPermitted?: () => boolean) {
        for (const event of events) {
          if (stillPermitted && !stillPermitted()) return;
          dispatched.push([event]);
        }
      },
      async dispose() {},
    };
    const emit = (frame: unknown) => {
      for (const listener of [...listeners]) listener(frame);
    };
    return { viewport, listeners, dispatched, emit };
  }

  function handlerWith(lease?: HandoffLease) {
    const { viewport, listeners, dispatched, emit } = makeViewport();
    const handler = new BrowserdRequestHandler({
      queue: { submit: vi.fn() },
      driver: {
        health: async () => ({ ok: true }),
        viewport: async () => viewport as never,
      },
      bootId: "boot-1",
      token: "t",
      ...(lease ? { lease } : {}),
    });
    return { handler, listeners, dispatched, emit };
  }

  it("lets anyone watch while nobody holds the browser", async () => {
    const { handler, listeners } = handlerWith();
    const result = await handler.subscribeFrames({ listener: () => {} });
    expect(result.ok).toBe(true);
    expect(listeners).toHaveLength(1);
  });

  it("shows frames to the holder, and to nobody else", async () => {
    // A second pane showing a person's password field as they type it is the
    // same leak as an agent screenshotting it.
    const lease = new HandoffLease();
    lease.acquire("rail-1", 60_000);
    const { handler, listeners } = handlerWith(lease);

    const theirs = await handler.subscribeFrames({
      holder: "rail-1",
      listener: () => {},
    });
    expect(theirs.ok).toBe(true);

    const others = await handler.subscribeFrames({
      holder: "rail-2",
      listener: () => {},
    });
    expect(others).toMatchObject({ ok: false, error: "lease_held" });
    const anonymous = await handler.subscribeFrames({ listener: () => {} });
    expect(anonymous).toMatchObject({ ok: false, error: "lease_held" });
    expect(listeners).toHaveLength(1);
  });

  it("takes input only from the person who holds the browser", async () => {
    const lease = new HandoffLease();
    lease.acquire("rail-1", 60_000);
    const { handler, dispatched } = handlerWith(lease);

    expect(
      await handler.dispatchInput({
        holder: "rail-1",
        events: [{ type: "text", text: "hunter2" }],
      }),
    ).toEqual({ ok: true });

    expect(
      await handler.dispatchInput({
        holder: "someone-else",
        events: [{ type: "text", text: "steal" }],
      }),
    ).toMatchObject({ ok: false, error: "lease_held_by_other" });

    expect(dispatched).toEqual([[{ type: "text", text: "hunter2" }]]);
  });

  it("refuses input when nobody has taken control", async () => {
    // With the lease free the agent may be mid-turn, and two drivers on one
    // page is what the lease exists to prevent. Take it first.
    const { handler, dispatched } = handlerWith();
    expect(
      await handler.dispatchInput({
        holder: "rail-1",
        events: [{ type: "text", text: "x" }],
      }),
    ).toMatchObject({ ok: false, error: "lease_required" });
    expect(dispatched).toHaveLength(0);
  });
});

/**
 * The setup-time checks above answer "who may start watching". These answer
 * "who may KEEP watching" — the lease moves, and a subscription taken while it
 * was free must not outlive that.
 */
describe("BrowserdRequestHandler — the lease moves mid-stream", () => {
  function makeViewport(afterEvent?: (delivered: number) => void) {
    const listeners: Array<(f: unknown) => void> = [];
    const viewport = {
      subscribe(listener: (f: unknown) => void) {
        listeners.push(listener);
        return () => {
          const i = listeners.indexOf(listener);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      subscriberCount: () => listeners.length,
      async dispatchInput(events: unknown[], stillPermitted?: () => boolean) {
        for (const event of events) {
          if (stillPermitted && !stillPermitted()) return;
          delivered.push(event);
          afterEvent?.(delivered.length);
        }
      },
      async dispose() {},
    };
    const delivered: unknown[] = [];
    return {
      viewport,
      delivered,
      emit: (frame: unknown) => {
        for (const listener of [...listeners]) listener(frame);
      },
      subscriberCount: () => listeners.length,
    };
  }

  function handlerWith(
    lease: HandoffLease,
    afterEvent?: (delivered: number) => void,
  ) {
    const v = makeViewport(afterEvent);
    const handler = new BrowserdRequestHandler({
      queue: { submit: vi.fn() },
      driver: {
        health: async () => ({ ok: true }),
        viewport: async () => v.viewport as never,
      },
      bootId: "boot-1",
      token: "t",
      lease,
    });
    return { handler, ...v };
  }

  it("stops frames, unsubscribes and says why when someone else takes control", async () => {
    const lease = new HandoffLease();
    const { handler, emit, subscriberCount } = handlerWith(lease);
    const frames: unknown[] = [];
    const revoked: string[] = [];

    const sub = await handler.subscribeFrames({
      listener: (f) => frames.push(f),
      onRevoked: (reason) => revoked.push(reason),
    });
    expect(sub.ok).toBe(true);

    emit({ seq: 1 });
    expect(frames).toHaveLength(1);

    // Somebody takes the browser. The socket that was watching a free page is
    // now a stranger looking over their shoulder.
    lease.acquire("rail-1", 60_000);
    emit({ seq: 2 });

    expect(frames).toHaveLength(1);
    expect(revoked).toEqual(["lease_held"]);
    expect(subscriberCount()).toBe(0);

    // Idempotent: further frames cannot revive it, and revoke fires once.
    emit({ seq: 3 });
    expect(frames).toHaveLength(1);
    expect(revoked).toHaveLength(1);
  });

  it("keeps showing the HOLDER their own frames", async () => {
    const lease = new HandoffLease();
    const { handler, emit } = handlerWith(lease);
    const frames: unknown[] = [];

    lease.acquire("rail-1", 60_000);
    await handler.subscribeFrames({
      holder: "rail-1",
      listener: (f) => frames.push(f),
    });

    emit({ seq: 1 });
    emit({ seq: 2 });

    expect(frames).toHaveLength(2);
  });

  it("stops a keystroke batch at the moment control changes", async () => {
    const lease = new HandoffLease();
    // The person hands the browser back (or their lease lapses) halfway
    // through a batch that is already in flight.
    const { handler, delivered } = handlerWith(lease, (count) => {
      if (count === 2) lease.release("rail-1");
    });
    lease.acquire("rail-1", 60_000);

    const events = ["h", "u", "n", "t"].map(
      (text) => ({ type: "text", text }) as const,
    );
    const result = await handler.dispatchInput({ holder: "rail-1", events });

    expect(result).toEqual({ ok: true });
    // Two, not four: the tail belongs to whoever holds the browser now.
    expect(delivered).toHaveLength(2);
  });
});


/**
 * V-7. The tier endpoint. Not lease-gated on purpose — it changes how the
 * picture is encoded, not what it shows.
 */
describe("BrowserdRequestHandler — POST /v1/policy", () => {
  function policyReq(body: unknown) {
    return {
      method: "POST",
      path: "/v1/policy",
      origin: undefined,
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify(body),
    };
  }

  it("passes a valid tier to the encoder", async () => {
    const tiers: string[] = [];
    const { handler } = makeHandler({
      setVideoTier: (tier: string) => tiers.push(tier),
    });
    const res = await handler.handle(policyReq({ tier: "saver" }));
    expect(res.status).toBe(200);
    expect(tiers).toEqual(["saver"]);
  });

  it("refuses a tier the encoder has no preset for", async () => {
    const tiers: string[] = [];
    const { handler } = makeHandler({
      setVideoTier: (tier: string) => tiers.push(tier),
    });
    expect((await handler.handle(policyReq({ tier: "mjpeg" }))).status).toBe(400);
    expect((await handler.handle(policyReq({}))).status).toBe(400);
    expect(tiers).toEqual([]);
  });

  it("answers 200 on a box with no encoder", async () => {
    // The caller's picture is a JPEG, whose quality this endpoint does not
    // govern; reporting a failure would send a pane looking for a problem it
    // does not have.
    const { handler } = makeHandler();
    expect((await handler.handle(policyReq({ tier: "sharp" }))).status).toBe(200);
  });

  it("still needs the bearer", async () => {
    const { handler } = makeHandler();
    const res = await handler.handle({
      ...policyReq({ tier: "sharp" }),
      authorization: undefined,
    });
    expect(res.status).toBe(401);
  });
});

/**
 * R-1. Motion looks the same whoever is driving.
 *
 * A person's input already bought 30fps for a second and a half; an agent's
 * `navigate` or `act` did not, so watching the model scroll a long page was a
 * 10fps slideshow on the throttle's floor. These pin the three things that
 * would silently come apart: which commands buy it, that an unwatched tab
 * never pays for one, and that a boost is never allowed to change a command's
 * answer.
 */
describe("BrowserdRequestHandler — the frame rate follows the page, not the hand", () => {
  function boostSpy() {
    const boosts: Array<[number, number]> = [];
    const viewport = {
      boost: (intervalMs: number, windowMs: number) =>
        boosts.push([intervalMs, windowMs]),
    };
    return { boosts, viewport };
  }

  function commandReq(action: BrowserCommand["action"], tabId?: string) {
    return req({
      body: JSON.stringify({
        command: { commandId: `c-${Math.random()}`, tabId, source: "chat", action },
      }),
    });
  }

  it("boosts a watched tab after a command that moved the page", async () => {
    const { boosts, viewport } = boostSpy();
    const { handler } = makeHandler({
      viewportIfWatched: () => Promise.resolve(viewport),
    });

    for (const action of [
      { kind: "navigate", url: "https://x.test/" },
      { kind: "back" },
      { kind: "reload" },
      { kind: "act", verb: "scroll" },
    ] as Array<BrowserCommand["action"]>) {
      expect((await handler.handle(commandReq(action))).status).toBe(200);
    }

    // 33ms is 30fps, the ceiling the transports carry; 1.5s covers the settle
    // after the command without holding a page at full rate for a whole turn.
    expect(boosts).toEqual([
      [33, 1_500],
      [33, 1_500],
      [33, 1_500],
      [33, 1_500],
    ]);
  });

  it("does not boost after an observe, which changed nothing on the page", async () => {
    // Reading the page moves no pixels. Boosting after one buys 45 extra JPEG
    // encodes of a picture that did not change, on cores the agent is using.
    const { boosts, viewport } = boostSpy();
    const { handler } = makeHandler({
      viewportIfWatched: () => Promise.resolve(viewport),
    });

    await handler.handle(commandReq({ kind: "observe", mode: "url" }));
    await handler.handle(
      commandReq({ kind: "webmcp_cancel", invocationId: "i-1" }),
    );

    expect(boosts).toEqual([]);
  });

  it("never CREATES a viewport for a tab nobody is watching", async () => {
    // The load-bearing one. `viewport()` opens a tab and attaches a CDP
    // screencast on a miss; if the boost went through it, every agent command
    // on an unattended box would start encoding JPEGs for an audience of
    // nobody. Revert `viewportIfWatched` back to `viewport` and this fails.
    const viewport = vi.fn(async () => ({ boost: () => {} }));
    const { handler } = makeHandler({
      viewport,
      viewportIfWatched: () => null,
    });

    const res = await handler.handle(
      commandReq({ kind: "navigate", url: "https://x.test/" }),
    );

    expect(res.status).toBe(200);
    expect(viewport).not.toHaveBeenCalled();
  });

  it("asks about the command's own tab", async () => {
    const asked: Array<string | undefined> = [];
    const { handler } = makeHandler({
      viewportIfWatched: (tabId?: string) => {
        asked.push(tabId);
        return null;
      },
    });

    await handler.handle(
      commandReq({ kind: "navigate", url: "https://x.test/" }, "tab-7"),
    );

    expect(asked).toEqual(["tab-7"]);
  });

  it("does not boost a command the lease refused", async () => {
    // Nothing ran and nothing was captured, so there is no repaint to cover —
    // and the person holding the browser should not have their pane's rate
    // decided by somebody else's refused command.
    const { boosts, viewport } = boostSpy();
    const lease = new HandoffLease();
    lease.acquire("rail-1");
    const { handler } = makeHandler({
      lease,
      viewportIfWatched: () => Promise.resolve(viewport),
    });

    const res = await handler.handle(
      commandReq({ kind: "navigate", url: "https://x.test/" }),
    );

    expect(res.status).toBe(423);
    expect(boosts).toEqual([]);
  });

  it("does not boost an outcome in which nothing ran", async () => {
    // `busy` was refused at the depth cap, `expired` lost its result to
    // eviction, `at_capacity` was never admitted. No page moved in any of
    // them, so boosting spends 45 JPEG encodes on a still picture — on the
    // cores the agent is using.
    for (const outcome of [
      { status: "busy" as const, bootId: BOOT },
      { status: "expired" as const, bootId: BOOT },
      { status: "at_capacity" as const, bootId: BOOT },
    ]) {
      const { boosts, viewport } = boostSpy();
      const { handler } = makeHandler({
        outcome,
        viewportIfWatched: () => Promise.resolve(viewport),
      });

      await handler.handle(commandReq({ kind: "reload" }));

      expect(boosts, `status=${outcome.status}`).toEqual([]);
    }
  });

  it("does not boost a command the queue ran and the driver refused", async () => {
    // A lease refusal re-asked at dequeue, or a stale-observation guard: the
    // queue reports `ok` and the RESULT says nothing was done. By
    // construction neither touched the page.
    const { boosts, viewport } = boostSpy();
    const { handler } = makeHandler({
      outcome: {
        status: "ok",
        result: { ok: false, staleObservation: true, error: "stale_observation" },
        bootId: BOOT,
      },
      viewportIfWatched: () => Promise.resolve(viewport),
    });

    await handler.handle(
      commandReq({ kind: "act", verb: "scroll" }),
    );

    expect(boosts).toEqual([]);
  });

  it("still answers the command when the boost throws", async () => {
    // A viewport whose page closed under it rejects here. The command already
    // succeeded and its result is already owed to the caller; a frame-rate
    // hint must never turn that into a 500.
    const { handler } = makeHandler({
      viewportIfWatched: () => Promise.reject(new Error("page closed")),
    });

    const res = await handler.handle(
      commandReq({ kind: "reload" }),
    );

    expect(res.status).toBe(200);
  });

  it("works against a driver too old to answer the question", async () => {
    const { handler } = makeHandler();
    expect((await handler.handle(commandReq({ kind: "reload" }))).status).toBe(200);
  });
});

/**
 * R-2. Recording control.
 *
 * A daemon ROUTE, not a `BrowserAction`: a recording outlives lease handoffs,
 * must not be refused while a person holds the browser, and must never enter
 * the at-most-once command queue, where a retried `stop` would be answered
 * from a cache instead of stopping anything.
 *
 * Every validation case asserts the recorder was NOT touched. An id becomes a
 * filename and an fps becomes an x11grab rate: getting either wrong after the
 * process is running means a file in the wrong place or an encoder at a rate
 * the box cannot sustain, and neither is visible from the 200 that comes back.
 */
describe("BrowserdRequestHandler — /v1/record", () => {
  function fakeRecorder(
    over: {
      start?: (args: { id: string; fps: number }) => unknown;
      stop?: () => Promise<unknown>;
      status?: () => unknown;
    } = {},
  ) {
    const started: Array<{ id: string; fps: number }> = [];
    const start = vi.fn((args: { id: string; fps: number }) => {
      started.push(args);
      return over.start ? over.start(args) : { ok: true };
    });
    const stop = vi.fn(over.stop ?? (async () => null));
    const status = vi.fn(over.status ?? (() => ({ active: false })));
    return { recorder: { start, stop, status }, start, stop, status, started };
  }

  function recordReq(body: unknown, method = "POST") {
    return {
      method,
      path: "/v1/record",
      origin: undefined,
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify(body),
    };
  }

  it("starts a take at the fps it was asked for and echoes both back", async () => {
    const { recorder, started } = fakeRecorder();
    const { handler } = makeHandler({ recorder });

    const res = await handler.handle(recordReq({ action: "start", id: "run-1", fps: 15 }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: "run-1", fps: 15 });
    expect(started).toEqual([{ id: "run-1", fps: 15 }]);
  });

  it("defaults fps to 15 rather than leaving the recorder to guess", async () => {
    const { recorder, started } = fakeRecorder();
    const { handler } = makeHandler({ recorder });

    const res = await handler.handle(recordReq({ action: "start", id: "run-1" }));

    expect(res.body).toMatchObject({ fps: 15 });
    expect(started).toEqual([{ id: "run-1", fps: 15 }]);
  });

  it("refuses an fps outside 1..30 BEFORE any spawn", async () => {
    const { recorder, start } = fakeRecorder();
    const { handler } = makeHandler({ recorder });

    for (const fps of [0, 31, -1, 15.5, "15", null]) {
      const res = await handler.handle(
        recordReq({ action: "start", id: "run-1", fps }),
      );
      expect(res.status, `fps=${String(fps)}`).toBe(400);
      expect(res.body).toMatchObject({ error: "invalid_fps" });
    }
    expect(start).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a plain filename, BEFORE any spawn", async () => {
    // It becomes a path. A `..` or a slash here is a directory the caller
    // chose, and the daemon writes wherever it points.
    const { recorder, start } = fakeRecorder();
    const { handler } = makeHandler({ recorder });

    for (const id of ["../etc/passwd", "a/b", "", "x".repeat(65), 7, undefined]) {
      const res = await handler.handle(
        recordReq({ action: "start", id, fps: 15 }),
      );
      expect(res.status, `id=${String(id)}`).toBe(400);
      expect(res.body).toMatchObject({ error: "invalid_record_id" });
    }
    expect(start).not.toHaveBeenCalled();
  });

  it("refuses an action it does not have, and invalid JSON", async () => {
    const { recorder, start } = fakeRecorder();
    const { handler } = makeHandler({ recorder });

    expect((await handler.handle(recordReq({ action: "pause" }))).status).toBe(400);
    expect((await handler.handle(recordReq({}))).status).toBe(400);
    expect((await handler.handle(recordReq(null))).status).toBe(400);
    expect(
      (await handler.handle({ ...recordReq({}), body: "{not json" })).status,
    ).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it("answers 503 record_unavailable on a box with no recorder", async () => {
    // The honest answer: `features` omits `"record"` in the first place, so a
    // caller that reads the status before asking never gets here.
    const { handler } = makeHandler();
    const res = await handler.handle(recordReq({ action: "start", id: "run-1" }));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "record_unavailable", id: "run-1" });
  });

  it("maps a refused second start to 409", async () => {
    const { recorder } = fakeRecorder({
      start: () => ({ ok: false, error: "record_active" }),
    });
    const { handler } = makeHandler({ recorder });
    const res = await handler.handle(recordReq({ action: "start", id: "run-2" }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "record_active", id: "run-2" });
  });

  it("maps a missing ffmpeg to 503", async () => {
    const { recorder } = fakeRecorder({
      start: () => ({ ok: false, error: "record_unavailable" }),
    });
    const { handler } = makeHandler({ recorder });
    expect(
      (await handler.handle(recordReq({ action: "start", id: "run-1" }))).status,
    ).toBe(503);
  });

  it("hands the stop result straight back, truncation and all", async () => {
    const recording = {
      path: "/rec/run-1.mp4",
      bytes: 1_234,
      durationMs: 9_000,
      distinctFrames: 42,
      truncated: true,
    };
    const { recorder } = fakeRecorder({ stop: async () => recording });
    const { handler } = makeHandler({ recorder });

    const res = await handler.handle(recordReq({ action: "stop" }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, recording });
  });

  it("answers 200 for a stop with nothing to stop", async () => {
    // Not a 409: a caller collecting evidence on a teardown path stops a take
    // that may have hit its size cap five minutes ago, and it needs an answer
    // it can read rather than an error it must special-case.
    const { recorder } = fakeRecorder({ stop: async () => null });
    const { handler } = makeHandler({ recorder });
    const res = await handler.handle(recordReq({ action: "stop" }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, recording: null });
  });

  it("reports the current state on GET, with a recorder or without one", async () => {
    const { recorder } = fakeRecorder({
      status: () => ({ active: true, id: "run-1", fps: 15, distinctFrames: 7 }),
    });
    const withOne = makeHandler({ recorder }).handler;
    const withNone = makeHandler().handler;

    expect((await withOne.handle(recordReq({}, "GET"))).body).toMatchObject({
      active: true,
      id: "run-1",
    });
    expect((await withNone.handle(recordReq({}, "GET"))).body).toMatchObject({
      active: false,
    });
  });

  it("is NOT blocked by a held lease", async () => {
    // The whole reason this is a route rather than a `BrowserAction`. A person
    // taking control mid-run must not end the recording of the run they took
    // it during — and this endpoint neither observes the page nor drives it.
    const lease = new HandoffLease();
    lease.acquire("someone-else");
    const { recorder, start, stop } = fakeRecorder();
    const { handler } = makeHandler({ lease, recorder });

    expect(
      (await handler.handle(recordReq({ action: "start", id: "run-1" }))).status,
    ).toBe(200);
    expect((await handler.handle(recordReq({ action: "stop" }))).status).toBe(200);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("still needs the bearer, and refuses a cross-origin caller", async () => {
    const { recorder, start } = fakeRecorder();
    const { handler } = makeHandler({ recorder });

    expect(
      (
        await handler.handle({
          ...recordReq({ action: "start", id: "run-1" }),
          authorization: undefined,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await handler.handle({
          ...recordReq({ action: "start", id: "run-1" }),
          origin: "https://evil.test",
        })
      ).status,
    ).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it("answers 405 for a method the route does not have", async () => {
    const { recorder } = fakeRecorder();
    const { handler } = makeHandler({ recorder });
    const res = await handler.handle(recordReq({}, "DELETE"));
    expect(res.status).toBe(405);
    expect(res.headers).toEqual({ allow: "GET, POST" });
  });
});
