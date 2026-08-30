import { describe, expect, it, vi } from "vitest";
import {
  BrowserdRequestHandler,
  type DaemonRequest,
} from "../request-handler";
import { HandoffLease } from "../lease";
import type { BrowserCommand, BrowserCommandOutcome } from "../../protocol";

const TOKEN = "s3cr3t-per-boot-token";
const BOOT = "boot-abc";

function makeHandler(over: {
  outcome?: BrowserCommandOutcome;
  submit?: (c: BrowserCommand) => Promise<BrowserCommandOutcome>;
  health?: () => Promise<{ ok: boolean; detail?: string }>;
  lease?: HandoffLease;
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
    driver: { health },
    bootId: BOOT,
    token: TOKEN,
    lease,
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
    expect(res.body).toEqual({ ok: true, bootId: BOOT });
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
    expect(res.body).toEqual({
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
  const commandFrom = (source: BrowserCommand["source"]) =>
    req({
      body: JSON.stringify({
        command: { commandId: "c1", source, action: { kind: "reload" } },
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
    const res = await handler.handle(commandFrom("manual"));
    expect(res.status).toBe(200);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("still runs a `manual` command while the lease is parked", async () => {
    const { handler, submit } = makeHandler({ lease: parkedLease() });
    const res = await handler.handle(commandFrom("manual"));
    expect(res.status).toBe(200);
    expect(submit).toHaveBeenCalledOnce();
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
