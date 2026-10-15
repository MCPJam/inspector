import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  AuthorizedToolInvoker,
  PluginInvocationSuspension,
  type PluginInvocationPorts,
  type TrustedInvocationOwner,
} from "../invocation";
import {
  createPluginInvocationReceiptPort,
  PLUGIN_COMBINED_CLAIM_RETRY_MS,
  resetPluginCombinedClaimDetection,
  type DurableInvocationReceipt,
  type PluginInvocationReceiptPort,
} from "../receipt-store";
const owner: TrustedInvocationOwner = {
  actorId: "actor",
  projectId: "project",
  workspaceId: "wid",
  instanceId: "original",
  generation: 1,
  serverId: "server",
  bindingId: "binding",
  placement: "interactive",
};
const env = {
  CONVEX_HTTP_URL: "https://disposable-receipt.invalid",
  INSPECTOR_SERVICE_TOKEN: "synthetic-service-secret",
};
const params = {
  name: "fixture",
  arguments: { exact: [false, 0, "雪\u0000"] },
};
const fp = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprint = fp(["app", params]);
function receipt(
  state:
    | "reserved"
    | "dispatched"
    | "completed"
    | "suspended"
    | "failed"
    | "unavailable" = "completed",
): DurableInvocationReceipt {
  return {
    fingerprint,
    revision: "revision-1",
    expiresAt: Date.now() + 60000,
    legs: [
      {
        round: 0,
        fingerprint,
        state,
        ...(state === "completed"
          ? {
              valueJson: JSON.stringify({
                content: [],
                structuredContent: { exact: [false, 0, "雪\u0000"] },
              }),
            }
          : state === "suspended"
            ? {
                valueJson: JSON.stringify({
                  continuationId: "parent",
                  round: 1,
                  status: "input_required",
                }),
                continuationId: "parent",
                pendingRound: 1,
              }
            : state === "unavailable"
              ? { errorCode: "RECEIPT_VALUE_UNAVAILABLE" }
              : state === "failed"
                ? { errorCode: "APPROVAL_DENIED" }
                : {}),
      },
    ],
  };
}
function ports(store: PluginInvocationReceiptPort): PluginInvocationPorts {
  return {
    receipts: store,
    authorize: vi.fn(async () => ({
      owner,
      revision: "revision-1",
      enabled: true,
      tool: { name: "fixture" },
      allowedOrigins: ["app" as const],
      requiresApproval: true,
    })),
    approve: vi.fn(async () => true),
    admit: vi.fn(async () => {}),
    metadata: vi.fn(async () => ({})),
    execute: vi.fn(async () => ({ content: [] })),
    classifyFailure: () => "unknown",
  };
}
function seeded(saved = receipt()) {
  const store: PluginInvocationReceiptPort = {
    read: vi.fn(async () => saved),
    claim: vi.fn(async () => ({ claimed: false, receipt: saved })),
    write: vi.fn(async () => {}),
  };
  const current = ports(store);
  return { store, current, invoker: new AuthorizedToolInvoker(owner, current) };
}
afterEach(() => vi.restoreAllMocks());
describe("the combined claim and dispatch", () => {
  const claim = {
    fingerprint,
    revision: "revision-1",
    writerHash: "a".repeat(64),
    round: 0,
    legFingerprint: fingerprint,
    dispatch: true as const,
  };
  const store = (refuse: (body: Record<string, unknown>) => string | null) => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const code = refuse(body);
      if (code) return Response.json({ code }, { status: 409 });
      return Response.json({
        claimed: true,
        receipt: {
          ...receipt(body.dispatch ? "dispatched" : "reserved"),
          legs: [
            {
              round: 0,
              fingerprint,
              state: body.dispatch ? "dispatched" : "reserved",
            },
          ],
        },
      });
    });
    return { bodies, fetchImpl };
  };
  afterEach(() => resetPluginCombinedClaimDetection());
  it("asks the store to claim and mark dispatched in one write", async () => {
    const s = store(() => null);
    const port = createPluginInvocationReceiptPort(owner, "subject", {
      env,
      fetchImpl: s.fetchImpl as unknown as typeof fetch,
    })!;
    const result = await port.claim("op", claim, AbortSignal.timeout(1000));
    expect(s.bodies).toEqual([
      expect.objectContaining({ action: "claim", dispatch: true }),
    ]);
    expect(result.receipt.legs[0]!.state).toBe("dispatched");
  });
  it("falls back to a plain claim on a store that refuses the field, and remembers", async () => {
    const s = store((body) =>
      body.dispatch ? "INVALID_RECEIPT_REQUEST" : null,
    );
    const port = createPluginInvocationReceiptPort(owner, "subject", {
      env,
      fetchImpl: s.fetchImpl as unknown as typeof fetch,
    })!;
    const first = await port.claim("op", claim, AbortSignal.timeout(1000));
    expect(first.receipt.legs[0]!.state).toBe("reserved");
    expect(s.bodies.map((body) => body.dispatch ?? false)).toEqual([
      true,
      false,
    ]);
    // Not asked again within the window: one plain claim.
    await port.claim("op-2", claim, AbortSignal.timeout(1000));
    expect(s.bodies.map((body) => body.dispatch ?? false)).toEqual([
      true,
      false,
      false,
    ]);
    // A backend deployed later is picked up after the window.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(
      now + PLUGIN_COMBINED_CLAIM_RETRY_MS + 1,
    );
    await port.claim("op-3", claim, AbortSignal.timeout(1000));
    expect(s.bodies.slice(3).map((body) => body.dispatch ?? false)).toEqual([
      true,
      false,
    ]);
  });
  it("never falls back on the store's own refusal", async () => {
    const s = store(() => "INVOCATION_ID_REUSED");
    const port = createPluginInvocationReceiptPort(owner, "subject", {
      env,
      fetchImpl: s.fetchImpl as unknown as typeof fetch,
    })!;
    await expect(
      port.claim("op", claim, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: "INVOCATION_ID_REUSED" });
    expect(s.bodies).toHaveLength(1);
  });
});
describe("trusted receipt request ports and recovery", () => {
  it("sends only digests in data and the service credential in its dedicated header", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ receipt: null }));
    const port = createPluginInvocationReceiptPort(
      owner,
      "synthetic-verified-subject",
      { env, fetchImpl },
    )!;
    await port.read("operation", new AbortController().signal);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://disposable-receipt.invalid/internal/v1/plugin-invocations",
    );
    expect(new Headers(init.headers).get("authorization")).toBeNull();
    expect(new Headers(init.headers).get("x-inspector-service-token")).toBe(
      env.INSPECTOR_SERVICE_TOKEN,
    );
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toEqual({
      action: "read",
      scopeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(String(init.body)).not.toMatch(/synthetic|actor|original/);
  });
  it.each([
    "actorId",
    "projectId",
    "workspaceId",
    "instanceId",
    "generation",
    "serverId",
    "bindingId",
    "placement",
    "runId",
    "subject",
  ])("changes the durable key when immutable %s changes", async (key) => {
    const keys: string[] = [];
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      keys.push(JSON.parse(init.body).scopeHash);
      return Response.json({ receipt: null });
    });
    await createPluginInvocationReceiptPort(owner, "subject", {
      env,
      fetchImpl,
    })!.read("op", new AbortController().signal);
    await createPluginInvocationReceiptPort(
      key === "subject"
        ? owner
        : { ...owner, [key]: key === "generation" ? 2 : "changed" },
      key === "subject" ? "changed" : "subject",
      { env, fetchImpl },
    )!.read("op", new AbortController().signal);
    expect(keys[0]).not.toBe(keys[1]);
  });
  it("has explicit local mode and refuses partial hosted configuration", () => {
    expect(
      createPluginInvocationReceiptPort(owner, "subject", { env: {} }),
    ).toBeUndefined();
    expect(() =>
      createPluginInvocationReceiptPort(owner, "subject", {
        env: { INSPECTOR_SERVICE_TOKEN: "configured" },
      }),
    ).toThrow("STORE_UNAVAILABLE");
  });
  it("assembles split UTF-8 bytes exactly and refuses oversized responses", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ receipt: { text: "雪🌱" } }),
    );
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
              c.close();
            },
          }),
        ),
    );
    expect(
      await createPluginInvocationReceiptPort(owner, "subject", {
        env,
        fetchImpl,
      })!.read("op", new AbortController().signal),
    ).toEqual({ text: "雪🌱" });
    const huge = async () => new Response("x".repeat(1024 * 1024 + 1));
    await expect(
      createPluginInvocationReceiptPort(owner, "subject", {
        env,
        fetchImpl: huge,
      })!.read("op", new AbortController().signal),
    ).rejects.toThrow("STORE_UNAVAILABLE");
  });
  it("observes adapter errors and refuses late results after abort", async () => {
    const controller = new AbortController();
    const fetchImpl = async () => {
      controller.abort();
      return Response.json({ receipt: null });
    };
    await expect(
      createPluginInvocationReceiptPort(owner, "subject", {
        env,
        fetchImpl,
      })!.read("op", controller.signal),
    ).rejects.toThrow("STORE_UNAVAILABLE");
  });
  it("recovers exact completed values without any approval/admission/metadata/execute port", async () => {
    const f = seeded();
    const result = await f.invoker.invoke("app", "op", params);
    expect(result).toEqual(JSON.parse(receipt().legs[0].valueJson!));
    expect(f.current.approve).not.toHaveBeenCalled();
    expect(f.current.admit).not.toHaveBeenCalled();
    expect(f.current.metadata).not.toHaveBeenCalled();
    expect(f.current.execute).not.toHaveBeenCalled();
  });
  it.each(["reserved", "dispatched", "failed", "unavailable"] as const)(
    "never executes a restored %s receipt",
    async (state) => {
      const f = seeded(receipt(state));
      await expect(f.invoker.invoke("app", "op", params)).rejects.toMatchObject(
        { outcomeUnknown: state === "reserved" || state === "dispatched" },
      );
      expect(f.current.approve).not.toHaveBeenCalled();
      expect(f.current.execute).not.toHaveBeenCalled();
    },
  );
  it("fences changed authority after a journal wait", async () => {
    const f = seeded();
    vi.mocked(f.store.claim).mockImplementation(async () => {
      vi.mocked(f.current.authorize).mockRejectedValue(new Error("revoked"));
      return { claimed: false, receipt: receipt() };
    });
    await expect(f.invoker.invoke("app", "op", params)).rejects.toThrow(
      "revoked",
    );
    expect(f.current.execute).not.toHaveBeenCalled();
  });
  it.each(["fingerprint", "expiresAt", "round"])(
    "rejects corrupt restored %s",
    async (field) => {
      const saved = receipt();
      if (field === "fingerprint") saved.fingerprint = "foreign";
      if (field === "expiresAt") saved.expiresAt = 0;
      if (field === "round") saved.legs[0].round = 2;
      const f = seeded(saved);
      await expect(f.invoker.invoke("app", "op", params)).rejects.toThrow(
        field === "fingerprint" ? "ID_REUSED" : "STORE_INVALID",
      );
      expect(f.current.execute).not.toHaveBeenCalled();
    },
  );
  it("recovers a parked round as the trusted suspension class and coalesces simultaneous recovery", async () => {
    const saved = receipt("suspended"),
      f = seeded(saved);
    let current = saved;
    vi.mocked(f.store.claim).mockImplementation(async (_id, input) => {
      current = {
        ...current,
        legs: [
          ...current.legs,
          { round: 1, fingerprint: input.legFingerprint, state: "reserved" },
        ],
      };
      return { claimed: true, receipt: current };
    });
    const resume = vi.fn(async () => ({
      content: [],
      structuredContent: { false: false, zero: 0 },
    }));
    f.current.continuation = {
      submission: {
        continuationId: "parent",
        round: 1,
        responsesBlobId: "owned-response",
      },
      resume,
    };
    const outputs = await Promise.all([
      f.invoker.invoke("app", "op", params),
      f.invoker.invoke("app", "op", params),
    ]);
    expect(outputs[0]).toEqual(outputs[1]);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(f.current.approve).not.toHaveBeenCalled();
    expect(f.current.execute).not.toHaveBeenCalled();
    const parked = seeded(saved);
    expect(await parked.invoker.invoke("app", "op", params)).toBeInstanceOf(
      PluginInvocationSuspension,
    );
  });
  it("records accepted intent before wire and retains oversized successful delivery without claiming recovery bytes", async () => {
    const store: PluginInvocationReceiptPort = {
      read: vi.fn(async () => null),
      claim: vi.fn(async () => ({
        claimed: true,
        receipt: receipt("reserved"),
      })),
      write: vi.fn(async () => {}),
    };
    const current = ports(store);
    const result = {
      content: [{ type: "text", text: "x".repeat(300 * 1024) }],
    };
    vi.mocked(current.execute).mockImplementation(async () => {
      expect(vi.mocked(store.write).mock.calls[0][1].state).toBe("dispatched");
      return result;
    });
    expect(
      await new AuthorizedToolInvoker(owner, current).invoke(
        "app",
        "op",
        params,
      ),
    ).toEqual(result);
    expect(vi.mocked(store.write).mock.calls[1][1]).toMatchObject({
      state: "unavailable",
      errorCode: "RECEIPT_VALUE_UNAVAILABLE",
    });
  });
});
