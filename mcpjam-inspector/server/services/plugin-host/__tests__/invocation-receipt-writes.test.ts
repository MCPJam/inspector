import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthorizedToolInvoker,
  createPluginAdmissionNoop,
  PluginInvocationError,
  PluginInvocationSuspension,
  PLUGIN_DEFERRED_RECEIPT_ATTEMPTS,
  PLUGIN_INVOCATION_ORIGINS,
  type AuthorizedInvocation,
  type PluginInvocationPorts,
  type TrustedInvocationOwner,
} from "../invocation.js";
import type {
  DurableInvocationLeg,
  DurableInvocationReceipt,
  PluginInvocationReceiptPort,
} from "../receipt-store.js";

const owner: TrustedInvocationOwner = {
  actorId: "actor",
  projectId: "project",
  workspaceId: "workspace",
  instanceId: "instance",
  generation: 1,
  serverId: "server",
  bindingId: "binding",
  placement: "interactive",
};

/** The backend receipt journal's round-0 rules, in memory: a claim reserves
 * (or, when the store supports it and is asked, marks dispatched), a refused
 * pre-wire leg releases the claim, anything else settles the leg. */
function ledger(store: { combined: boolean } = { combined: true }) {
  const rows = new Map<
    string,
    { fingerprint: string; revision: string; legs: DurableInvocationLeg[] }
  >();
  const log: string[] = [];
  const snapshot = (id: string): DurableInvocationReceipt => {
    const row = rows.get(id)!;
    return {
      fingerprint: row.fingerprint,
      revision: row.revision,
      expiresAt: Date.now() + 60_000,
      legs: structuredClone(row.legs),
    };
  };
  const port: PluginInvocationReceiptPort = {
    read: vi.fn(async (id) => (rows.has(id) ? snapshot(id) : null)),
    claim: vi.fn(async (id, input) => {
      log.push(input.dispatch ? "claim+dispatch" : "claim");
      if (rows.has(id)) return { claimed: false, receipt: snapshot(id) };
      rows.set(id, {
        fingerprint: input.fingerprint,
        revision: input.revision,
        legs: [
          {
            round: 0,
            fingerprint: input.legFingerprint,
            state: input.dispatch && store.combined ? "dispatched" : "reserved",
          },
        ],
      });
      return { claimed: true, receipt: snapshot(id) };
    }),
    write: vi.fn(async (id, input) => {
      log.push(`write:${input.state}`);
      if (input.state === "refused") {
        rows.delete(id);
        return;
      }
      const leg = rows.get(id)!.legs[0]!;
      leg.state = input.state;
      if (input.valueJson !== undefined) leg.valueJson = input.valueJson;
      if (input.errorCode !== undefined) leg.errorCode = input.errorCode;
    }),
  };
  return { port, log, rows };
}

function fixture(
  receipts: PluginInvocationReceiptPort,
  overrides: Partial<PluginInvocationPorts> = {},
  authorization: Partial<AuthorizedInvocation> = {},
) {
  const deferred: (() => Promise<void>)[] = [];
  const ports: PluginInvocationPorts = {
    receipts,
    authorize: vi.fn(async () => ({
      revision: "revision",
      owner,
      enabled: true,
      tool: { name: "tool" },
      allowedOrigins: PLUGIN_INVOCATION_ORIGINS,
      requiresApproval: false,
      ...authorization,
    })),
    approve: vi.fn(async () => true),
    admit: createPluginAdmissionNoop(),
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    classifyFailure: () => "unknown",
    defer: (work) => {
      deferred.push(work);
    },
    ...overrides,
  };
  return {
    ports,
    invoker: new AuthorizedToolInvoker(owner, ports),
    /** Run what the request handed off, as the route does after answering. */
    flush: () => Promise.all(deferred.splice(0).map((work) => work())),
    deferred,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("receipt writes on an App call's critical path", () => {
  it("claims and marks dispatched in one write when nothing gated runs between them", async () => {
    const l = ledger();
    const f = fixture(l.port);
    await expect(
      f.invoker.invoke("app", "call", { name: "tool" }),
    ).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    // Before the answer: one write. The completion record waits for it.
    expect(l.log).toEqual(["claim+dispatch"]);
    // A fresh authorization before the claim, after it, and after the call.
    expect(f.ports.authorize).toHaveBeenCalledTimes(3);
    await f.flush();
    expect(l.log).toEqual(["claim+dispatch", "write:completed"]);
    expect(l.rows.get("call")!.legs[0]!.state).toBe("completed");
  });

  it.each([
    ["approval", {}, { requiresApproval: true }],
    ["an admission service", { admit: vi.fn(async () => {}) }, {}],
    ["a metadata service", { metadata: vi.fn(async () => ({})) }, {}],
  ] as const)(
    "keeps claim and dispatch apart when %s runs between them",
    async (_case, overrides, authorization) => {
      const l = ledger();
      const f = fixture(l.port, overrides, authorization);
      await f.invoker.invoke("app", "call", { name: "tool" });
      expect(l.log).toEqual(["claim", "write:dispatched"]);
      expect(f.ports.execute).toHaveBeenCalledOnce();
    },
  );

  it("writes dispatched itself when the store left the leg reserved", async () => {
    const l = ledger({ combined: false });
    const f = fixture(l.port);
    await f.invoker.invoke("app", "call", { name: "tool" });
    expect(l.log).toEqual(["claim+dispatch", "write:dispatched"]);
    // The older order: a fresh authorization after each write.
    expect(f.ports.authorize).toHaveBeenCalledTimes(4);
  });

  it("releases a combined claim as refused when the authorization after it fails", async () => {
    const l = ledger();
    const f = fixture(l.port);
    vi.mocked(f.ports.authorize)
      .mockResolvedValueOnce({
        revision: "revision",
        owner,
        enabled: true,
        tool: { name: "tool" },
        allowedOrigins: PLUGIN_INVOCATION_ORIGINS,
        requiresApproval: false,
      })
      .mockRejectedValueOnce(new PluginInvocationError("INSTANCE_UNAVAILABLE"));
    await expect(
      f.invoker.invoke("app", "call", { name: "tool" }),
    ).rejects.toMatchObject({ code: "INSTANCE_UNAVAILABLE" });
    expect(f.ports.execute).not.toHaveBeenCalled();
    // Nothing ran: the claim is released and a retry starts over.
    expect(l.log).toEqual(["claim+dispatch", "write:refused"]);
    expect(l.rows.has("call")).toBe(false);
  });

  it("writes a suspension's record before answering: its continuation reads it next", async () => {
    const l = ledger();
    const pending = new PluginInvocationSuspension({
      continuationId: "continuation",
      round: 1,
      status: "input_required",
    });
    const f = fixture(l.port, { execute: vi.fn(async () => pending) });
    await expect(
      f.invoker.invoke("app", "call", { name: "tool" }),
    ).resolves.toBe(pending);
    expect(l.log).toEqual(["claim+dispatch", "write:suspended"]);
    expect(f.deferred).toHaveLength(0);
  });

  it("writes the completion before answering when the request has no scheduler", async () => {
    const l = ledger();
    const f = fixture(l.port, { defer: undefined });
    await f.invoker.invoke("app", "call", { name: "tool" });
    expect(l.log).toEqual(["claim+dispatch", "write:completed"]);
  });

  it("never runs the call again when its completion record never lands", async () => {
    const l = ledger();
    const f = fixture(l.port);
    await f.invoker.invoke("app", "call", { name: "tool" });
    // The process ends before the deferred write: the leg says dispatched.
    f.deferred.length = 0;
    expect(l.rows.get("call")!.legs[0]!.state).toBe("dispatched");
    // A retry in another process (a fresh invoker on the same store).
    const retry = fixture(l.port);
    await expect(
      retry.invoker.invoke("app", "call", { name: "tool" }),
    ).rejects.toMatchObject({
      code: "INVOCATION_OUTCOME_UNKNOWN",
      outcomeUnknown: true,
    });
    expect(retry.ports.execute).not.toHaveBeenCalled();
    expect(f.ports.execute).toHaveBeenCalledOnce();
    // This process still replays the answer from memory.
    await expect(
      f.invoker.invoke("app", "call", { name: "tool" }),
    ).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(f.ports.execute).toHaveBeenCalledOnce();
  });

  it("retries a deferred completion after a transport failure, a bounded number of times", async () => {
    vi.useFakeTimers();
    const l = ledger();
    const write = l.port.write;
    l.port.write = vi.fn(async (id, input, signal) => {
      if (input.state === "completed")
        throw new PluginInvocationError("RECEIPT_STORE_UNAVAILABLE");
      return write(id, input, signal);
    });
    const f = fixture(l.port);
    await f.invoker.invoke("app", "call", { name: "tool" });
    const flushed = f.flush();
    await vi.runAllTimersAsync();
    await flushed;
    expect(
      vi
        .mocked(l.port.write)
        .mock.calls.filter(([, input]) => input.state === "completed"),
    ).toHaveLength(PLUGIN_DEFERRED_RECEIPT_ATTEMPTS);
  });

  it("does not retry a deferred completion the store refused", async () => {
    const l = ledger();
    l.port.write = vi.fn(async () => {
      throw new PluginInvocationError("RECEIPT_SETTLED");
    });
    const f = fixture(l.port);
    await f.invoker.invoke("app", "call", { name: "tool" });
    await f.flush();
    expect(
      vi
        .mocked(l.port.write)
        .mock.calls.filter(([, input]) => input.state === "completed"),
    ).toHaveLength(1);
  });
});
