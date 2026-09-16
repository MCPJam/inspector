/**
 * The handler's ledger duties.
 *
 * The reason these live at the HANDLER rather than around the executor is the
 * whole point of the design, and it is what most of this file asserts: a lease
 * refusal, a `command_unknown_boot`, and the queue's own `busy` / `expired` /
 * `at_capacity` outcomes never reach an executor, so a ledger wrapped around
 * one would record exactly the commands that ran and lose every command that
 * was refused.
 */
import { describe, expect, it, vi } from "vitest";
import { BrowserdRequestHandler, type DaemonRequest } from "../request-handler";
import { CommandLedger, type BrowserLedgerRow } from "../command-ledger";
import { HandoffLease } from "../lease";
import type { BrowserCommand, BrowserCommandOutcome } from "../../protocol";

const TOKEN = "s3cr3t-per-boot-token";
const BOOT = "boot-abc";

function makeHandler(
  over: {
    outcome?: BrowserCommandOutcome;
    submit?: (c: BrowserCommand) => Promise<BrowserCommandOutcome>;
    lease?: HandoffLease;
    captureTypedText?: boolean;
  } = {},
) {
  const ledger = new CommandLedger({ bootId: BOOT });
  const submit =
    over.submit ??
    vi.fn(
      async (): Promise<BrowserCommandOutcome> =>
        over.outcome ?? { status: "ok", result: { ok: true }, bootId: BOOT },
    );
  const lease = over.lease ?? new HandoffLease();
  const handler = new BrowserdRequestHandler({
    queue: { submit },
    driver: { health: async () => ({ ok: true as const }) },
    bootId: BOOT,
    token: TOKEN,
    lease,
    ledger,
    ...(over.captureTypedText ? { captureTypedText: true } : {}),
  });
  return { handler, ledger, lease, submit };
}

function commandReq(
  command: Partial<BrowserCommand> = {},
  extra: Record<string, unknown> = {},
): DaemonRequest {
  return {
    method: "POST",
    path: "/v1/commands",
    origin: undefined,
    authorization: `Bearer ${TOKEN}`,
    body: JSON.stringify({
      command: {
        commandId: "c1",
        source: "agent",
        action: { kind: "reload" },
        actor: { kind: "agent", id: "cli:abc" },
        ...command,
      },
      ...extra,
    }),
  };
}

function rows(ledger: CommandLedger): BrowserLedgerRow[] {
  return ledger
    .read({ limit: 100 })
    .entries.filter((e): e is BrowserLedgerRow => e.kind === "command");
}

describe("BrowserdRequestHandler — the ledger", () => {
  it("records an executed command, attributed to the actor on the envelope", async () => {
    const { handler, ledger } = makeHandler({
      outcome: {
        status: "ok",
        result: { ok: true, output: { url: "https://x.test/p?token=abc" } },
        bootId: BOOT,
      },
    });
    const res = await handler.handle(
      commandReq({
        sessionId: "sess-1",
        correlation: { chatSessionId: "chat-7" },
      }),
    );
    expect(res.status).toBe(200);
    const [row] = rows(ledger);
    expect(row).toMatchObject({
      commandId: "c1",
      source: "agent",
      outcome: "executed",
      ok: true,
      actor: { kind: "agent", id: "cli:abc" },
      sessionId: "sess-1",
      correlation: { chatSessionId: "chat-7" },
      url: "https://x.test/p",
      viewport: { width: 1024, height: 768 },
    });
  });

  it("records a LEASE REFUSAL — the row the whole trace exists for", async () => {
    const lease = new HandoffLease();
    lease.acquire("alice");
    const { handler, ledger, submit } = makeHandler({ lease });
    const res = await handler.handle(commandReq());
    expect(res.status).toBe(423);
    // Refused BEFORE the queue: nothing ran, so a ledger wrapped around the
    // executor would have no row at all here.
    expect(submit).not.toHaveBeenCalled();
    const [row] = rows(ledger);
    expect(row).toMatchObject({
      outcome: "refused",
      errorCode: "lease_held",
      actor: { kind: "agent", id: "cli:abc" },
    });
  });

  it("captures nothing about the page on a lease refusal", async () => {
    const lease = new HandoffLease();
    lease.acquire("alice");
    const { handler, ledger } = makeHandler({ lease });
    await handler.handle(
      commandReq({ action: { kind: "observe", mode: "screenshot" } }),
    );
    const [row] = rows(ledger);
    expect(row.artifacts).toBeUndefined();
    expect(row.url).toBeUndefined();
    expect(row.stateToken).toBeUndefined();
    expect(row.viewport).toBeUndefined();
  });

  it("records a stale-observation refusal, WITH the fresh page it hands back", async () => {
    const { handler, ledger } = makeHandler({
      outcome: {
        status: "ok",
        result: {
          ok: true,
          staleObservation: true,
          output: { url: "https://x.test/moved", screenshot: "AAAA" },
        },
        bootId: BOOT,
      },
    });
    const res = await handler.handle(commandReq());
    expect(res.status).toBe(409);
    const [row] = rows(ledger);
    // Nothing RAN — but the observation the refusal carries was legitimately
    // captured, and it is what the caller will re-decide from.
    expect(row).toMatchObject({
      outcome: "refused",
      errorCode: "stale_observation",
      url: "https://x.test/moved",
    });
    expect(row.artifacts?.screenshot).toBeDefined();
  });

  it("records a handoff that landed INSIDE the queue as a refusal, with no page", async () => {
    const { handler, ledger } = makeHandler({
      outcome: {
        status: "ok",
        result: { ok: false, leaseBlocked: true, error: "lease_parked: mid-handoff" },
        bootId: BOOT,
      },
    });
    const res = await handler.handle(commandReq());
    expect(res.status).toBe(423);
    const [row] = rows(ledger);
    expect(row).toMatchObject({ outcome: "refused", errorCode: "lease_parked" });
    expect(row.artifacts).toBeUndefined();
  });

  it("records `command_unknown_boot` as UNKNOWN, never as refused", async () => {
    // The distinction that matters: "refused" tells a caller retrying is safe.
    // Across a restart the first execution's fate is unknowable, which is
    // exactly why the daemon will not re-run it.
    const { handler, ledger } = makeHandler();
    const res = await handler.handle(commandReq({}, { expectedBootId: "boot-old" }));
    expect(res.status).toBe(409);
    const [row] = rows(ledger);
    expect(row).toMatchObject({
      outcome: "unknown",
      errorCode: "command_unknown_boot",
    });
  });

  it("records an evicted result as UNKNOWN and back-pressure as REFUSED", async () => {
    for (const [status, outcome, errorCode] of [
      ["expired", "unknown", "command_expired"],
      ["busy", "refused", "busy"],
      ["at_capacity", "refused", "daemon_at_capacity"],
    ] as const) {
      const { handler, ledger } = makeHandler({
        outcome: { status, bootId: BOOT } as BrowserCommandOutcome,
      });
      await handler.handle(commandReq());
      expect(rows(ledger)[0]).toMatchObject({ outcome, errorCode });
    }
  });

  it("adds NO row for a duplicate that resolved to a recorded execution", async () => {
    // One execution, one row. A caller retrying through a flaky transport must
    // not appear in the trace to have clicked the button twice.
    let deduped = false;
    const { handler, ledger } = makeHandler({
      submit: async () => ({
        status: "ok",
        result: { ok: true },
        bootId: BOOT,
        ...(deduped ? { deduped: true } : {}),
      }),
    });
    await handler.handle(commandReq());
    deduped = true;
    await handler.handle(commandReq());
    expect(rows(ledger)).toHaveLength(1);
  });

  it("records a duplicate whose original row has aged out, marked as one", async () => {
    const ledger = new CommandLedger({ bootId: BOOT });
    const handler = new BrowserdRequestHandler({
      queue: {
        submit: async () => ({
          status: "ok",
          result: { ok: true },
          bootId: BOOT,
          deduped: true,
        }),
      },
      driver: { health: async () => ({ ok: true as const }) },
      bootId: BOOT,
      token: TOKEN,
      ledger,
    });
    // Nothing was ever recorded for `c1`, so there is no row to link to.
    // Silently minting a plain `executed` row would double-count the click;
    // silently dropping it would lose that the agent asked again.
    await handler.handle(commandReq());
    expect(rows(ledger)[0]).toMatchObject({ outcome: "executed", deduped: true });
  });

  it("redacts a typed value by default and keeps it under the session opt-in", async () => {
    const typing = commandReq({
      action: { kind: "act", verb: "type", value: "hunter2" },
    });
    const { handler, ledger } = makeHandler();
    await handler.handle(typing);
    expect(rows(ledger)[0].command).toMatchObject({
      verb: "type",
      redactedValue: { redacted: true, chars: 7 },
    });
    expect(JSON.stringify(rows(ledger)[0])).not.toContain("hunter2");

    const opted = makeHandler({ captureTypedText: true });
    await opted.handler.handle(typing);
    expect(rows(opted.ledger)[0].command).toMatchObject({ value: "hunter2" });
  });

  it("records an unattributed actor rather than inventing a plausible one", async () => {
    const { handler, ledger } = makeHandler();
    await handler.handle(
      commandReq({ actor: undefined, source: "chat" } as Partial<BrowserCommand>),
    );
    expect(rows(ledger)[0].actor).toEqual({
      kind: "inspector",
      id: "unattributed",
    });
  });

  it("writes no row for a body the handler could not parse into a command", async () => {
    // There is no commandId to record against, and a row keyed on nothing would
    // be noise in the one place that has to stay readable.
    const { handler, ledger } = makeHandler();
    await handler.handle({
      method: "POST",
      path: "/v1/commands",
      origin: undefined,
      authorization: `Bearer ${TOKEN}`,
      body: "{not json",
    });
    expect(rows(ledger)).toHaveLength(0);
  });
});

describe("BrowserdRequestHandler — /v1/trace and /v1/artifact", () => {
  const read = (path: string, query?: string): DaemonRequest => ({
    method: "GET",
    path,
    origin: undefined,
    authorization: `Bearer ${TOKEN}`,
    body: "",
    ...(query ? { query: new URLSearchParams(query) } : {}),
  });

  it("reads the ledger forward from a cursor", async () => {
    const { handler, ledger } = makeHandler();
    await handler.handle(commandReq({ commandId: "c1" }));
    await handler.handle(commandReq({ commandId: "c2" }));
    const res = await handler.handle(read("/v1/trace", "afterSeq=1"));
    expect(res.status).toBe(200);
    const body = res.body as { entries: BrowserLedgerRow[]; headSeq: number };
    expect(body.entries.map((e) => e.commandId)).toEqual(["c2"]);
    expect(body.headSeq).toBe(ledger.headSeq);
  });

  it("requires the bearer, like every route but /healthz", async () => {
    const { handler } = makeHandler();
    const res = await handler.handle({ ...read("/v1/trace"), authorization: undefined });
    expect(res.status).toBe(401);
  });

  it("hands back one artifact payload, and 410s once it has aged out", async () => {
    const { handler, ledger } = makeHandler({
      outcome: {
        status: "ok",
        result: { ok: true, output: { screenshot: "AAAA" } },
        bootId: BOOT,
      },
    });
    await handler.handle(commandReq());
    const id = rows(ledger)[0].artifacts!.screenshot!.id;
    const found = await handler.handle(read("/v1/artifact", `id=${id}`));
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ artifact: { data: "AAAA" } });

    // Released once something durable has it.
    const released = await handler.handle({
      ...read("/v1/artifact", `id=${id}`),
      method: "DELETE",
    });
    expect(released.status).toBe(200);
    const gone = await handler.handle(read("/v1/artifact", `id=${id}`));
    // 410, not 404: this id was real and points at the row's `evicted` marker
    // rather than at a typo.
    expect(gone.status).toBe(410);
  });

  it("says it is not recording rather than answering an empty list", async () => {
    const handler = new BrowserdRequestHandler({
      queue: { submit: async () => ({ status: "ok", result: { ok: true }, bootId: BOOT }) },
      driver: { health: async () => ({ ok: true as const }) },
      bootId: BOOT,
      token: TOKEN,
    });
    const res = await handler.handle(read("/v1/trace"));
    // "Nothing happened" and "I am not recording" are different answers and a
    // caller acts differently on each.
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ error: "ledger_unavailable" });
  });
});

describe("BrowserdRequestHandler — a Playground act on the ledger", () => {
  it("carries the tool call AND the chat session on its row", async () => {
    // The field has existed since the ledger did, and only the CODING-AGENT
    // door ever filled it: every command the model sent arrived with a bare
    // `commandId` and nothing joining it to the turn that caused it. A row
    // could be read and could not be traced back to why it happened.
    const { handler, ledger } = makeHandler();
    const res = await handler.handle(
      commandReq({
        correlation: {
          chatSessionId: "chat-7",
          toolCallId: "call_abc123",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(rows(ledger)[0]).toMatchObject({
      correlation: { chatSessionId: "chat-7", toolCallId: "call_abc123" },
    });
  });

  it("records an eval iteration's act against its iteration", async () => {
    const { handler, ledger } = makeHandler();
    await handler.handle(
      commandReq({ correlation: { iterationId: "iter-3", toolCallId: "c1" } }),
    );
    expect(rows(ledger)[0]).toMatchObject({
      correlation: { iterationId: "iter-3" },
    });
  });

  it("records a row with no correlation at all, as every caller used to", async () => {
    const { handler, ledger } = makeHandler();
    await handler.handle(commandReq({}));
    expect(rows(ledger)[0]?.correlation).toBeUndefined();
  });
});
