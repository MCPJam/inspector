import { describe, expect, it, vi } from "vitest";
import {
  BrowserdRequestHandler,
  type DaemonRequest,
} from "../request-handler";
import type { BrowserCommand, BrowserCommandOutcome } from "../../protocol";

const TOKEN = "s3cr3t-per-boot-token";
const BOOT = "boot-abc";

function makeHandler(over: {
  outcome?: BrowserCommandOutcome;
  submit?: (c: BrowserCommand) => Promise<BrowserCommandOutcome>;
  health?: () => Promise<{ ok: boolean; detail?: string }>;
} = {}) {
  const submit =
    over.submit ??
    vi.fn(async () => over.outcome ?? { status: "ok", result: { ok: true }, bootId: BOOT });
  const health = over.health ?? (async () => ({ ok: true as const }));
  const handler = new BrowserdRequestHandler({
    queue: { submit },
    driver: { health },
    bootId: BOOT,
    token: TOKEN,
  });
  return { handler, submit };
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
