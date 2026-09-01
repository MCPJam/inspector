import { describe, expect, it, vi } from "vitest";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
} from "../../../utils/hosted-egress-guard.js";
import {
  capSetupAuditMetadata,
  classifySetupAttribution,
  connectSpanId,
  createRunSetupObserver,
  SETUP_AUDIT_METADATA_KEY,
  toolsListSpanId,
  type SetupAuditRecord,
} from "../run-setup-signals.js";

function nodeError(code: string, message = code): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

function httpError(status: number, message = `HTTP ${status}`): Error {
  const error = new Error(message);
  (error as Error & { status: number }).status = status;
  return error;
}

describe("classifySetupAttribution", () => {
  it("classifies DNS / blocked egress as ours", () => {
    expect(classifySetupAttribution(new EgressResolutionError("no such host"))).toBe(
      "ours"
    );
    expect(
      classifySetupAttribution(new BlockedEgressTargetError("169.254.169.254"))
    ).toBe("ours");
    expect(classifySetupAttribution(nodeError("ENOTFOUND"))).toBe("ours");
  });

  it("classifies 401/403 and transport-local MCP codes as ours", () => {
    expect(classifySetupAttribution(httpError(401))).toBe("ours");
    expect(classifySetupAttribution(httpError(403))).toBe("ours");
    const mcp = new Error("request timeout");
    (mcp as Error & { mcpErrorCode: number }).mcpErrorCode = -32001;
    expect(classifySetupAttribution(mcp)).toBe("ours");
  });

  it("classifies refused / TLS / timeout / 5xx as theirs", () => {
    expect(classifySetupAttribution(nodeError("ECONNREFUSED"))).toBe("theirs");
    expect(classifySetupAttribution(nodeError("ETIMEDOUT"))).toBe("theirs");
    expect(classifySetupAttribution(httpError(502))).toBe("theirs");
    expect(
      classifySetupAttribution(new Error("unable to verify the first certificate"))
    ).toBe("theirs");
  });

  it("classifies everything else as unknown", () => {
    expect(classifySetupAttribution(new Error("something odd"))).toBe("unknown");
  });

  // A cancelled run says NOTHING about the target server. Without this arm
  // an abort classifies `unknown`, and an `unknown` tools/list failure on a
  // server whose initialize completed derives `discovery: failed` — the
  // user pressing stop, reported as the server's fault.
  it("classifies our own cancellation as ours, by name and by code", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(classifySetupAttribution(abort)).toBe("ours");
    expect(classifySetupAttribution(nodeError("ABORT_ERR"))).toBe("ours");
    expect(classifySetupAttribution(nodeError("ERR_CANCELED"))).toBe("ours");
    const canceled = new Error("canceled");
    canceled.name = "CanceledError";
    expect(classifySetupAttribution(canceled)).toBe("ours");
    expect(
      classifySetupAttribution(new Error("This operation was aborted"))
    ).toBe("ours");
  });

  // The guard on the cancellation heuristic: ECONNABORTED contains the word
  // "aborted" and is a real peer-side reset, so a loose /abort/i would flip
  // a measurable server failure into a setup abort.
  it("keeps ECONNABORTED as theirs — the word 'aborted' is not enough", () => {
    expect(classifySetupAttribution(nodeError("ECONNABORTED"))).toBe("theirs");
    expect(
      classifySetupAttribution(new Error("connect ECONNABORTED 10.0.0.1:443"))
    ).toBe("theirs");
  });
});

describe("createRunSetupObserver folding", () => {
  it("omits signals when no servers are configured", () => {
    const observer = createRunSetupObserver({ expectedServerIds: [] });
    observer.recordConnect("ghost", {
      outcome: "ok",
      startedAt: 0,
      endedAt: 1,
    });
    expect(observer.buildSignals()).toBeUndefined();
  });

  it("folds all-ok as outcome ok", () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["a", "b"],
    });
    for (const id of ["a", "b"]) {
      observer.recordConnect(id, { outcome: "ok", startedAt: 0, endedAt: 1 });
      observer.recordToolsList(id, { outcome: "ok", startedAt: 1, endedAt: 2 });
    }
    expect(observer.buildSignals()).toEqual({
      connection: { outcome: "ok", durationMs: 1 },
      discovery: { outcome: "ok", durationMs: 1 },
    });
  });

  it("lets ours dominate a mixed bag so it cannot earn connection:failed", () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["a", "b"],
    });
    observer.recordConnect("a", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 0,
      endedAt: 1,
    });
    observer.recordConnect("b", {
      outcome: "failed",
      error: nodeError("ENOTFOUND"),
      startedAt: 0,
      endedAt: 1,
    });
    const signals = observer.buildSignals();
    expect(signals?.connection).toMatchObject({
      outcome: "failed",
      attribution: "ours",
      spanIds: [connectSpanId("a"), connectSpanId("b")],
    });
  });

  it("lets unknown dominate verified-theirs", () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["a", "b"],
    });
    observer.recordConnect("a", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 0,
      endedAt: 1,
    });
    observer.recordConnect("b", {
      outcome: "failed",
      error: new Error("something odd"),
      startedAt: 0,
      endedAt: 1,
    });
    expect(observer.buildSignals()?.connection?.attribution).toBe("unknown");
  });

  it("folds an unobserved target as unknown", () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["a", "b"],
    });
    observer.recordConnect("a", {
      outcome: "ok",
      startedAt: 0,
      endedAt: 1,
    });
    expect(observer.buildSignals()?.connection).toMatchObject({
      outcome: "failed",
      attribution: "unknown",
    });
    expect(observer.buildSignals()?.connection?.durationMs).toBeUndefined();
  });

  it("emits the settled-target wall envelope for a complete phase", () => {
    const observer = createRunSetupObserver({ expectedServerIds: ["a", "b"] });
    observer.recordConnect("a", { outcome: "ok", startedAt: 10, endedAt: 25 });
    observer.recordConnect("b", { outcome: "ok", startedAt: 20, endedAt: 50 });
    expect(observer.buildSignals()?.connection?.durationMs).toBe(40);
  });

  it("omits the duration when any settled target has an inverted interval", () => {
    const observer = createRunSetupObserver({ expectedServerIds: ["a", "b"] });
    observer.recordConnect("a", { outcome: "ok", startedAt: 10, endedAt: 25 });
    observer.recordConnect("b", { outcome: "ok", startedAt: 40, endedAt: 20 });
    expect(observer.buildSignals()?.connection).toEqual({ outcome: "ok" });
  });

  // Absence of evidence, not evidence of failure: when connect fails for
  // every target, tools/list never runs, so the phase reports nothing and
  // the stage falls through to `notReached` behind the connection failure.
  it("emits no signal for a phase that never ran for any target", () => {
    const observer = createRunSetupObserver({ expectedServerIds: ["a"] });
    observer.recordConnect("a", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 0,
      endedAt: 1,
    });
    const signals = observer.buildSignals();
    expect(signals?.connection).toMatchObject({ outcome: "failed" });
    expect(signals?.discovery).toBeUndefined();
  });

  it("caps culprit span ids at 5", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const observer = createRunSetupObserver({ expectedServerIds: ids });
    for (const id of ids) {
      observer.recordConnect(id, {
        outcome: "failed",
        error: nodeError("ECONNREFUSED"),
        startedAt: 0,
        endedAt: 1,
      });
    }
    expect(observer.buildSignals()?.connection?.spanIds).toHaveLength(5);
  });
});

describe("createRunSetupObserver canary + spans", () => {
  it("never runs the canary for an ours failure", async () => {
    const canary = vi.fn(async () => true);
    const observer = createRunSetupObserver({
      expectedServerIds: ["srv"],
      canary,
    });
    observer.recordConnect("srv", {
      outcome: "failed",
      error: nodeError("ENOTFOUND"),
      startedAt: 0,
      endedAt: 1,
    });
    expect(observer.buildSignals()?.connection).toMatchObject({
      outcome: "failed",
      attribution: "ours",
    });
    expect(observer.buildSignals()?.connection?.egressVerified).toBeUndefined();
    expect(canary).not.toHaveBeenCalled();
  });

  it("runs the canary once per run, only when asked, on theirs", async () => {
    const canary = vi.fn(async () => true);
    const observer = createRunSetupObserver({
      expectedServerIds: ["srv"],
      canary,
    });
    observer.recordConnect("srv", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 0,
      endedAt: 1,
    });
    expect(canary).not.toHaveBeenCalled();
    await expect(observer.ensureEgressCanary()).resolves.toBe(true);
    await expect(observer.ensureEgressCanary()).resolves.toBe(true);
    expect(canary).toHaveBeenCalledTimes(1);
    expect(observer.buildSignals()?.connection).toMatchObject({
      outcome: "failed",
      attribution: "theirs",
      egressVerified: true,
    });
  });

  it("clamps synthetic span position to offset 0 and keeps duration", () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["srv"],
    });
    observer.recordConnect("srv", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 1_000,
      endedAt: 1_042,
    });
    observer.recordToolsList("srv", {
      outcome: "ok",
      startedAt: 1_042,
      endedAt: 1_050,
    });
    const spans = observer.buildSyntheticSpans(500);
    expect(spans).toEqual([
      {
        id: connectSpanId("srv"),
        name: "connect",
        category: "connection",
        status: "error",
        serverId: "srv",
        startMs: 0,
        endMs: 42,
      },
      {
        id: toolsListSpanId("srv"),
        name: "tools/list",
        category: "discovery",
        status: "ok",
        serverId: "srv",
        startMs: 0,
        endMs: 8,
      },
    ]);
  });

  it("persists a bounded audit record with the folded signals", async () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["srv"],
      canary: async () => true,
      now: () => 99,
    });
    observer.recordConnect("srv", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 0,
      endedAt: 1,
    });
    await observer.ensureEgressCanary();
    const audit = observer.buildAuditMetadata();
    // ONE top-level metadata key. Iteration metadata is a flat open record
    // shared by every producer, so the audit record nests rather than
    // scattering generic words like `egressCanary` across it.
    expect(Object.keys(audit ?? {})).toEqual([SETUP_AUDIT_METADATA_KEY]);
    const record = audit?.[SETUP_AUDIT_METADATA_KEY] as SetupAuditRecord;
    expect(record.signals).toMatchObject({
      connection: {
        outcome: "failed",
        attribution: "theirs",
        egressVerified: true,
      },
    });
    expect(record.egressCanary).toEqual({ ran: true, ok: true, at: 99 });
    expect(JSON.stringify(audit).length).toBeLessThanOrEqual(2048);
  });

  it("does not attach a failed canary to a theirs discovery after connect ok", async () => {
    const canary = vi.fn(async () => false);
    const observer = createRunSetupObserver({
      expectedServerIds: ["srv"],
      canary,
    });
    observer.recordConnect("srv", {
      outcome: "ok",
      startedAt: 0,
      endedAt: 1,
    });
    observer.recordToolsList("srv", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 1,
      endedAt: 2,
    });
    expect(observer.buildSignals()).toMatchObject({
      connection: { outcome: "ok" },
      discovery: { outcome: "failed", attribution: "theirs" },
    });
    expect(observer.buildSignals()?.discovery?.egressVerified).toBeUndefined();
    expect(canary).not.toHaveBeenCalled();
  });

  // "we did not check" and "we checked and our egress is down" are
  // different states. Only an explicit `true` may ever earn
  // `connection: failed`, so an unrun canary leaves the field absent
  // rather than stamping a false.
  it("omits egressVerified entirely when the canary never ran", () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["srv"],
      canary: async () => true,
    });
    observer.recordConnect("srv", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 0,
      endedAt: 1,
    });
    const connection = observer.buildSignals()?.connection;
    expect(connection).toMatchObject({
      outcome: "failed",
      attribution: "theirs",
    });
    expect(connection && "egressVerified" in connection).toBe(false);
  });

  it("shares one canary promise instead of polling", async () => {
    let resolveCanary!: (ok: boolean) => void;
    const canary = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCanary = resolve;
        })
    );
    const observer = createRunSetupObserver({
      expectedServerIds: ["srv"],
      canary,
    });
    const first = observer.ensureEgressCanary();
    const second = observer.ensureEgressCanary();
    expect(canary).toHaveBeenCalledTimes(1);
    resolveCanary(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(await observer.ensureEgressCanary()).toBe(true);
    expect(canary).toHaveBeenCalledTimes(1);
  });

  it("sheds span ids when the audit blob exceeds the cap", () => {
    const raw = {
      signals: {
        connection: {
          outcome: "failed" as const,
          attribution: "theirs" as const,
          spanIds: ["run-connect-aaaaaaaaaaaaaaaa"],
        },
      },
      egressCanary: { ran: true, ok: true, at: 1 },
    };
    const capped = capSetupAuditMetadata(raw, 10);
    expect(capped.truncated).toBe(true);
    expect(capped.signals.connection?.spanIds).toBeUndefined();
    expect(JSON.stringify(capped).length).toBeLessThan(JSON.stringify(raw).length);
  });
});
