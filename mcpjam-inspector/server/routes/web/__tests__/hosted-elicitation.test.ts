import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessageChunk } from "ai";

const mutation = vi.fn();
const action = vi.fn();
let creationFetch: typeof fetch | undefined;
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    constructor(_url: string, options?: { fetch?: typeof fetch }) {
      creationFetch = options?.fetch;
    }
    setAuth = vi.fn();
    action = (...args: unknown[]) => action(...args);
    mutation = (...args: unknown[]) => mutation(...args);
  },
}));

import {
  HostedElicitationBridge,
  hostDeclaresElicitation,
  resolveElicitationGate,
} from "../hosted-elicitation.js";

type Captured = { type: string; data: any; transient?: boolean };

function makeWriter() {
  const chunks: Captured[] = [];
  return {
    writer: {
      write: (c: UIMessageChunk) => chunks.push(c as unknown as Captured),
    },
    chunks,
    events: () => chunks.map((c) => c.data),
  };
}

/** Minimal callback request; the SDK always supplies serverId in practice. */
function formRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    serverId: "srv-1",
    message: "Pick a branch",
    schema: { type: "object", properties: { branch: { type: "string" } } },
    ...overrides,
  } as any;
}

/** Route responses, keyed by path, consumed in order. */
function stubFetch(routes: Record<string, unknown[]>) {
  const calls: Array<{ path: string; body: any }> = [];
  const cursor: Record<string, number> = {};
  const fetchMock = vi.fn(async (url: string, init: any) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(init.body) });
    const queue = routes[path];
    if (!queue) return { ok: true, json: async () => ({ ok: true }) } as any;
    const idx = Math.min(cursor[path] ?? 0, queue.length - 1);
    cursor[path] = (cursor[path] ?? 0) + 1;
    const next = queue[idx];
    if (next instanceof Error) throw next;
    return { ok: true, json: async () => next } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

const pollPending = { ok: true, elicitation: { status: "pending" } };
const pollAnswered = {
  ok: true,
  elicitation: {
    status: "answered",
    action: "accept",
    content: { branch: "main" },
  },
};

function makeBridge(overrides: Partial<any> = {}) {
  return new HostedElicitationBridge({
    convexBearer: "Bearer jwt-token",
    projectId: "proj-1",
    chatSessionId: "sess-1",
    serverNamesById: { "srv-1": "GitHub" },
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  creationFetch = undefined;
  mutation.mockReset().mockResolvedValue({ ok: true });
  action.mockReset().mockResolvedValue({ ok: true });
  process.env.CONVEX_URL = "https://convex.test";
  process.env.CONVEX_HTTP_URL = "https://convex-http.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "svc-token";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("hostDeclaresElicitation", () => {
  it("accepts every shape the catalog actually ships", () => {
    // Bare {} is form-only per the spec's back-compat rule; the catalog uses
    // both it and the explicit form. Presence of the key is the toggle.
    expect(hostDeclaresElicitation({ elicitation: {} })).toBe(true);
    expect(hostDeclaresElicitation({ elicitation: { form: {} } })).toBe(true);
    expect(
      hostDeclaresElicitation({ elicitation: { form: {}, url: {} } }),
    ).toBe(true);
  });

  it("rejects absence and non-object junk", () => {
    expect(hostDeclaresElicitation(undefined)).toBe(false);
    expect(hostDeclaresElicitation({})).toBe(false);
    expect(hostDeclaresElicitation({ elicitation: true })).toBe(false);
    expect(hostDeclaresElicitation({ elicitation: "yes" })).toBe(false);
    expect(hostDeclaresElicitation({ elicitation: [] })).toBe(false);
    expect(hostDeclaresElicitation({ roots: {} })).toBe(false);
  });
});

describe("resolveElicitationGate", () => {
  const ON = { elicitation: {} };
  const OFF = { roots: {} };

  it("enables a direct turn from the body when the client speaks v1", () => {
    const gate = resolveElicitationGate({
      hostAuthoritative: false,
      hostClientCapabilities: undefined,
      bodyClientCapabilities: ON,
      clientVersion: 1,
    });
    expect(gate.enabled).toBe(true);
    expect(gate.effectiveClientCapabilities).toBe(ON);
  });

  it("ignores the body for a scenario turn and uses the published host", () => {
    // THE security property: a share-link visitor controls the body. If the
    // published host has elicitation off, no body can switch it on.
    const gate = resolveElicitationGate({
      hostAuthoritative: true,
      hostClientCapabilities: OFF,
      bodyClientCapabilities: ON,
      clientVersion: 1,
    });
    expect(gate.enabled).toBe(false);
    expect(gate.effectiveClientCapabilities).toBe(OFF);
  });

  it("ignores the body for an ENVIRONMENT turn too", () => {
    // An environment turn is host-authoritative for the same structural
    // reason: the server decides what the environment resolves to, so the
    // capability declaration must come from that resolution rather than the
    // caller. Deliberately NOT symmetric with model / prompt / temperature /
    // approval, which stay body-overridable on an environment turn as
    // ephemeral Playground tweaks — a capability changes what goes on the
    // initialize wire, which is not a per-turn preference.
    const gate = resolveElicitationGate({
      hostAuthoritative: true,
      hostClientCapabilities: OFF,
      bodyClientCapabilities: ON,
      clientVersion: 1,
    });
    expect(gate.enabled).toBe(false);
    expect(gate.effectiveClientCapabilities).toBe(OFF);
  });

  it("honors a scenario host that DOES declare elicitation", () => {
    const gate = resolveElicitationGate({
      hostAuthoritative: true,
      hostClientCapabilities: ON,
      bodyClientCapabilities: undefined,
      clientVersion: 1,
    });
    expect(gate.enabled).toBe(true);
    expect(gate.effectiveClientCapabilities).toBe(ON);
  });

  it("fails closed for a scenario when the backend omits clientCapabilities", () => {
    // Backend predating the runtime-config field → absent → off, never "trust
    // the body instead".
    const gate = resolveElicitationGate({
      hostAuthoritative: true,
      hostClientCapabilities: undefined,
      bodyClientCapabilities: ON,
      clientVersion: 1,
    });
    expect(gate.enabled).toBe(false);
    expect(gate.effectiveClientCapabilities).toBeUndefined();
  });

  it.each([[undefined], [0], [2], ["1"]])(
    "stays off when the client handshake is %p",
    (clientVersion) => {
      // Catalog hosts already declare elicitation; without the handshake an old
      // bundle would hang for a TTL on any server that elicits.
      const gate = resolveElicitationGate({
        hostAuthoritative: false,
        hostClientCapabilities: undefined,
        bodyClientCapabilities: ON,
        clientVersion: clientVersion as number | undefined,
      });
      expect(gate.enabled).toBe(false);
      // The capability still goes on the wire decision unchanged — only the
      // honoring is gated.
      expect(gate.effectiveClientCapabilities).toBe(ON);
    },
  );

  it("stays off when the host does not declare it, even at v1", () => {
    expect(
      resolveElicitationGate({
        hostAuthoritative: false,
        hostClientCapabilities: undefined,
        bodyClientCapabilities: OFF,
        clientVersion: 1,
      }).enabled,
    ).toBe(false);
  });
});

describe("HostedElicitationBridge", () => {
  it("joins abort and repeated disposal through one pending cancellation", async () => {
    let release!: (value: unknown) => void;
    const cancellation = new Promise((resolve) => {
      release = resolve;
    });
    const { calls } = stubFetch({
      "/elicitations/poll": [pollPending],
      "/elicitations/cancel": [cancellation],
    });
    const stop = new AbortController();
    const bridge = makeBridge({ abortSignal: stop.signal });
    bridge.attachStreamWriter(makeWriter().writer);
    const answer = bridge.callback(formRequest());
    await vi.advanceTimersByTimeAsync(0);
    stop.abort();
    const first = bridge.dispose(),
      second = bridge.dispose();
    expect(second).toBe(first);
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      calls.filter((call) => call.path === "/elicitations/cancel"),
    ).toHaveLength(1);
    expect(settled).toBe(false);
    release({ ok: true });
    await first;
    expect(settled).toBe(true);
    await expect(answer).resolves.toEqual({ action: "cancel" });
  });
  it.each([false, true])(
    "binds the original source through inline/private creation (%s) and releases after delivery",
    async (large) => {
      stubFetch({ "/elicitations/poll": [pollAnswered] });
      const token = "A".repeat(43),
        release = vi.fn();
      const bindPluginForm = vi.fn(async () => ({ token, release }));
      const { writer, events } = makeWriter();
      const bridge = makeBridge({
        pluginWorkspaceId: "workspace",
        bindPluginForm,
      });
      bridge.attachStreamWriter(writer);
      const schema = {
        type: "object",
        properties: {},
        ...(large ? { description: "π".repeat(20000) } : {}),
      };
      const pending = bridge.callback(formRequest({ schema }));
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toMatchObject({ action: "accept" });
      const input = (large ? action : mutation).mock.calls[0][1];
      expect(input.pluginFormSourceToken).toBe(token);
      expect(bindPluginForm).toHaveBeenCalledWith({
        rendezvousId: input.rendezvousId,
        serverId: "srv-1",
        schema,
        expiresAt: expect.any(Number),
      });
      expect(
        events().find((event) => event.kind === "request")
          .pluginFormSourceToken,
      ).toBe(token);
      expect(release).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses a form with no admitted source before creating a parent", async () => {
    const bridge = makeBridge({
      pluginWorkspaceId: "workspace",
      bindPluginForm: async () => {
        throw new Error("No admitted invocation");
      },
    });
    expect(await bridge.callback(formRequest())).toEqual({ action: "cancel" });
    expect(mutation).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });
  it("releases the source on failed creation and withdraws a late create after disposal", async () => {
    const { calls } = stubFetch({});
    const release = vi.fn();
    let finish: (value: unknown) => void = () => {};
    mutation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const bridge = makeBridge({
      pluginWorkspaceId: "workspace",
      bindPluginForm: async () => ({ token: "A".repeat(43), release }),
    });
    const pending = bridge.callback(formRequest());
    await vi.advanceTimersByTimeAsync(0);
    const closing = bridge.dispose();
    expect(bridge.dispose()).toBe(closing);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    finish({ ok: true });
    await closing;
    expect(await pending).toEqual({ action: "cancel" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.path)).toContain("/elicitations/cancel");
    const failed = makeBridge({
      pluginWorkspaceId: "workspace",
      bindPluginForm: async () => ({ token: "B".repeat(43), release }),
    });
    mutation.mockRejectedValueOnce(new Error("Storage unavailable"));
    expect(await failed.callback(formRequest())).toEqual({ action: "cancel" });
    expect(release).toHaveBeenCalledTimes(2);
  });
  it("cancels immediately when no writer is attached, without touching Convex", async () => {
    // The pre-writer window is connect/tools-list inside prepareChatV2, which
    // BLOCKS stream creation — buffering here would deadlock until TTL.
    stubFetch({});
    const bridge = makeBridge();

    const result = await bridge.callback(formRequest());

    expect(result).toEqual({ action: "cancel" });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("cancels when the rendezvous row cannot be created", async () => {
    stubFetch({});
    const { writer } = makeWriter();
    mutation.mockRejectedValueOnce(new Error("convex down"));
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    // A broken rendezvous has nothing to answer it — hanging the tool call
    // would be strictly worse than a clean cancel.
    await expect(bridge.callback(formRequest())).resolves.toEqual({
      action: "cancel",
    });
  });

  it("stores large owned schemas through the authenticated action and emits only a marker", async () => {
    stubFetch({ "/elicitations/poll": [pollAnswered] });
    const { writer, events } = makeWriter();
    const bridge = makeBridge({ pluginWorkspaceId: "workspace" });
    bridge.attachStreamWriter(writer);
    const schema = {
      type: "object",
      description: "π".repeat(20000),
      properties: {},
    };
    const pending = bridge.callback(formRequest({ schema }));
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toMatchObject({ action: "accept" });
    expect(action).toHaveBeenCalledWith(
      "pluginFormSchemas:create",
      expect.objectContaining({
        projectId: "proj-1",
        pluginWorkspaceId: "workspace",
        requestedSchemaJson: JSON.stringify(schema),
      }),
    );
    expect(mutation).not.toHaveBeenCalled();
    const event = events().find((value) => value.kind === "request");
    expect(event).toMatchObject({
      hasPrivateSchema: true,
      formDialect: "openai",
    });
    expect(event).not.toHaveProperty("requestedSchema");
    expect(event).not.toHaveProperty("requestedSchemaBlobId");
  });
  it.each(["ordinary", "unusual"])(
    "uses private JSON only when a small owned schema needs it: %s",
    async (kind) => {
      stubFetch({ "/elicitations/poll": [pollAnswered] });
      const { writer, events } = makeWriter();
      const bridge = makeBridge({ pluginWorkspaceId: "workspace" });
      bridge.attachStreamWriter(writer);
      const schema = {
        type: "object",
        properties: {
          [kind === "ordinary" ? "branch" : 'branch"\\\nπ\0']: {
            type: "string",
          },
        },
      };
      const pending = bridge.callback(formRequest({ schema }));
      await vi.advanceTimersByTimeAsync(2000);
      await expect(pending).resolves.toMatchObject({ action: "accept" });
      if (kind === "ordinary") {
        expect(action).not.toHaveBeenCalled();
        expect(mutation).toHaveBeenCalledWith(
          "elicitations:createElicitation",
          expect.objectContaining({ requestedSchema: schema }),
        );
      } else {
        expect(mutation).not.toHaveBeenCalled();
        expect(action).toHaveBeenCalledWith(
          "pluginFormSchemas:create",
          expect.objectContaining({
            requestedSchemaJson: JSON.stringify(schema),
          }),
        );
        expect(action.mock.calls[0][1]).not.toHaveProperty("requestedSchema");
        expect(
          events().find((value) => value.kind === "request"),
        ).toMatchObject({ hasPrivateSchema: true });
      }
    },
  );
  it("keeps the ordinary mutation path even for an oversized ordinary request", async () => {
    stubFetch({ "/elicitations/poll": [pollAnswered] });
    const { writer } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);
    const pending = bridge.callback(
      formRequest({ schema: { description: "π".repeat(20000) } }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(action).not.toHaveBeenCalled();
    expect(mutation).toHaveBeenCalledWith(
      "elicitations:createElicitation",
      expect.any(Object),
    );
  });
  it("cancels without a pending dialog when private schema creation fails", async () => {
    stubFetch({});
    const { writer, events } = makeWriter();
    const bridge = makeBridge({ pluginWorkspaceId: "workspace" });
    bridge.attachStreamWriter(writer);
    action.mockRejectedValueOnce(new Error("Private form schema unavailable"));
    await expect(
      bridge.callback(
        formRequest({ schema: { description: "π".repeat(20000) } }),
      ),
    ).resolves.toEqual({ action: "cancel" });
    expect(events()).toEqual([]);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("emits the request part, then resolves the answered content", async () => {
    stubFetch({ "/elicitations/poll": [pollPending, pollAnswered] });
    const { writer, events } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    const promise = bridge.callback(formRequest());
    await vi.advanceTimersByTimeAsync(3000);

    await expect(promise).resolves.toEqual({
      action: "accept",
      content: { branch: "main" },
    });

    const request = events().find((e) => e.kind === "request");
    expect(request).toMatchObject({
      serverId: "srv-1",
      serverName: "GitHub",
      mode: "form",
      message: "Pick a branch",
      chatSessionId: "sess-1",
    });
    expect(typeof request.rendezvousId).toBe("string");
    expect(events()).toContainEqual(
      expect.objectContaining({ kind: "resolved", outcome: "answered" }),
    );
  });

  it("marks request parts transient so they never enter the transcript", async () => {
    stubFetch({ "/elicitations/poll": [pollAnswered] });
    const { writer, chunks } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    const promise = bridge.callback(formRequest());
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.type).toBe("data-elicitation");
      expect(chunk.transient).toBe(true);
    }
  });

  it("does not ack while the answer is still pending", async () => {
    // Acking early would scrub a payload we never received. (The complementary
    // guarantee — that reading via /elicitations/poll has no side effects — is
    // enforced and tested backend-side; the bridge cannot observe it.)
    const { calls } = stubFetch({ "/elicitations/poll": [pollPending] });
    const { writer } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    void bridge.callback(formRequest());
    await vi.advanceTimersByTimeAsync(6000);

    expect(
      calls.filter((c) => c.path === "/elicitations/poll").length,
    ).toBeGreaterThan(1);
    expect(calls.some((c) => c.path === "/elicitations/ack")).toBe(false);
  });

  it("acks exactly once, and only for an answered row", async () => {
    const { calls } = stubFetch({
      "/elicitations/poll": [pollPending, pollAnswered],
    });
    const { writer } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    const promise = bridge.callback(formRequest());
    await vi.advanceTimersByTimeAsync(3000);
    await promise;
    await vi.advanceTimersByTimeAsync(50);

    const acks = calls.filter((c) => c.path === "/elicitations/ack");
    expect(acks).toHaveLength(1);
    expect(acks[0].body.rendezvousId).toEqual(
      calls.find((c) => c.path === "/elicitations/poll")!.body.rendezvousId,
    );
  });

  it("does not ack a terminal row it never consumed an answer from", async () => {
    // expired/cancelled carry no content; the backend scrubs those inline.
    const { calls } = stubFetch({
      "/elicitations/poll": [{ ok: true, elicitation: { status: "expired" } }],
    });
    const { writer } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    const promise = bridge.callback(formRequest());
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    await vi.advanceTimersByTimeAsync(50);

    expect(calls.some((c) => c.path === "/elicitations/ack")).toBe(false);
  });

  it("never sends content for a url-mode accept", async () => {
    // Spec: URL-mode results carry no content. Inventing one would be a lie
    // about what the user supplied.
    stubFetch({
      "/elicitations/poll": [
        { ok: true, elicitation: { status: "answered", action: "accept" } },
      ],
    });
    const { writer } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    const promise = bridge.callback(
      formRequest({
        mode: "url",
        url: "https://example.com/connect",
        elicitationId: "srv-chosen-1",
        schema: undefined,
      }),
    );
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).resolves.toEqual({ action: "accept" });
  });

  it.each([
    [
      "decline",
      { status: "answered", action: "decline" },
      { action: "decline" },
    ],
    ["expired", { status: "expired" }, { action: "cancel" }],
    ["cancelled", { status: "cancelled" }, { action: "cancel" }],
  ])("resolves %s terminal states", async (_label, elicitation, expected) => {
    stubFetch({ "/elicitations/poll": [{ ok: true, elicitation }] });
    const { writer } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    const promise = bridge.callback(formRequest());
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).resolves.toEqual(expected);
  });

  it("cancels on client abort and withdraws the row without emitting", async () => {
    const { calls } = stubFetch({ "/elicitations/poll": [pollPending] });
    const controller = new AbortController();
    const { writer, events } = makeWriter();
    const bridge = makeBridge({ abortSignal: controller.signal });
    bridge.attachStreamWriter(writer);

    const promise = bridge.callback(formRequest());
    await vi.advanceTimersByTimeAsync(1500);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1500);

    await expect(promise).resolves.toEqual({ action: "cancel" });
    // Nobody is listening once the stream is gone, so no resolved part.
    expect(events().some((e) => e.kind === "resolved")).toBe(false);
    expect(calls.some((c) => c.path === "/elicitations/cancel")).toBe(true);
  });

  it("cancels once the local deadline passes rather than waiting on the cron", async () => {
    stubFetch({ "/elicitations/poll": [pollPending] });
    const { writer, events } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    const promise = bridge.callback(formRequest());
    // Past ELICITATION_FORM_TTL_MS (5 min).
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 5_000);

    await expect(promise).resolves.toEqual({ action: "cancel" });
    expect(events()).toContainEqual(
      expect.objectContaining({ kind: "resolved", outcome: "expired" }),
    );
  });

  it("tolerates transient poll failures, then cancels after the ceiling", async () => {
    stubFetch({ "/elicitations/poll": [new Error("network")] });
    const { writer } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    const promise = bridge.callback(formRequest());
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(promise).resolves.toEqual({ action: "cancel" });
  });

  it.each([
    [false, "headers"],
    [false, "body"],
    [true, "headers"],
    [true, "body"],
  ] as const)(
    "bounds creation through %s private storage and stalled %s during owner close",
    async (privateSchema, stage) => {
      let creationSignal: AbortSignal | undefined;
      const cancellations: Array<{ signal: AbortSignal; body: any }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: any) => {
          if (new URL(url).pathname === "/elicitations/cancel") {
            cancellations.push({
              signal: init.signal,
              body: JSON.parse(init.body),
            });
            return { ok: true, json: async () => ({ ok: true }) };
          }
          creationSignal = init.signal;
          const stall = () =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener(
                "abort",
                () => reject(init.signal.reason),
                { once: true },
              );
            });
          if (stage === "headers") return stall();
          return { ok: true, json: stall };
        }),
      );
      (privateSchema ? action : mutation).mockImplementationOnce(async () => {
        const response = await creationFetch!(
          "https://convex.test/api/create",
          { method: "POST" },
        );
        return response.json();
      });
      const stop = new AbortController(),
        release = vi.fn();
      const { writer, events } = makeWriter();
      const bridge = makeBridge({
        abortSignal: stop.signal,
        pluginWorkspaceId: "workspace",
        bindPluginForm: async () => ({ token: "A".repeat(43), release }),
      });
      bridge.attachStreamWriter(writer);
      const answer = bridge.callback(
        formRequest({
          schema: {
            type: "object",
            properties: {},
            ...(privateSchema ? { description: "π".repeat(25000) } : {}),
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(creationSignal?.aborted).toBe(false);
      stop.abort();
      const closing = bridge.dispose();
      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(9999);
      expect(closed).toBe(false);
      expect(creationSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      await expect(answer).resolves.toEqual({ action: "cancel" });
      expect(creationSignal?.aborted).toBe(true);
      expect(cancellations).toHaveLength(1);
      expect(cancellations[0].signal.aborted).toBe(false);
      expect(cancellations[0].body.rendezvousId).toBe(
        (privateSchema ? action : mutation).mock.calls[0][1].rendezvousId,
      );
      expect(release).toHaveBeenCalledTimes(1);
      expect(events()).toEqual([]);
    },
  );

  it("bounds a stalled Convex call instead of hanging the tool forever", async () => {
    // Without a deadline the poll never returns: the TTL check only runs
    // between polls, so the tool call would outlive its TTL with nothing able
    // to resolve it. A stall must degrade to a poll failure, not a hang.
    const hang = vi.fn(
      (_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    vi.stubGlobal("fetch", hang);
    const { writer } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    const promise = bridge.callback(formRequest());
    // 5 failures × (10s deadline + ~1s backoff) — comfortably covered.
    await vi.advanceTimersByTimeAsync(90_000);

    await expect(promise).resolves.toEqual({ action: "cancel" });
  });

  it("does not bind cancel to the turn signal", async () => {
    // dispose() runs BECAUSE the turn ended. Binding the withdraw request to
    // the turn's signal would abort the very call meant to retract the prompt,
    // leaving it answerable for its whole TTL.
    const seen: Array<boolean> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        if (new URL(url).pathname === "/elicitations/cancel") {
          seen.push(Boolean(init.signal?.aborted));
        }
        return { ok: true, json: async () => ({ ok: true }) } as any;
      }),
    );
    const controller = new AbortController();
    const { writer } = makeWriter();
    const bridge = makeBridge({ abortSignal: controller.signal });
    bridge.attachStreamWriter(writer);

    void bridge.callback(formRequest());
    await vi.advanceTimersByTimeAsync(50);
    controller.abort();
    await bridge.dispose();
    await vi.advanceTimersByTimeAsync(50);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((aborted) => aborted === false)).toBe(true);
  });

  it("withdraws still-pending rows on dispose", async () => {
    const { calls } = stubFetch({ "/elicitations/poll": [pollPending] });
    const { writer } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    void bridge.callback(formRequest());
    await vi.advanceTimersByTimeAsync(1500);
    await bridge.dispose();

    expect(calls.some((c) => c.path === "/elicitations/cancel")).toBe(true);
  });

  it("emits url_required for -32042 without creating a rendezvous row", async () => {
    stubFetch({});
    const { writer, events } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    bridge.emitUrlRequired({
      serverId: "srv-1",
      toolCallId: "call-9",
      elicitations: [
        {
          url: "https://example.com/auth",
          elicitationId: "e1",
          message: "Connect",
        },
      ],
    });

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "url_required",
        serverId: "srv-1",
        serverName: "GitHub",
        toolCallId: "call-9",
      }),
    );
    // No JSON-RPC response is owed on the error path.
    expect(mutation).not.toHaveBeenCalled();
  });

  it("emitUrlRequired is engine-agnostic: it only needs the writer", async () => {
    // Guards the BYOK fix. The org branches run `runDirectChatTurn`, where the
    // AI SDK owns the tool loop and never reaches the shared executor's catch —
    // so the old engine-level hook compiled and silently never fired for BYOK
    // users. Emission now hangs off the tool set every engine shares, so the
    // bridge needs nothing engine-specific to surface a -32042.
    stubFetch({});
    const { writer, events } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    bridge.emitUrlRequired({
      serverId: "srv-1",
      toolCallId: "byok-call",
      elicitations: [
        { url: "https://example.com/connect", elicitationId: "e1" },
      ],
    });

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "url_required",
        toolCallId: "byok-call",
      }),
    );
  });

  it("drops a url_required with no elicitations rather than emit an empty notice", async () => {
    stubFetch({});
    const { writer, events } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    bridge.emitUrlRequired({ serverId: "srv-1", elicitations: [] });

    expect(events()).toHaveLength(0);
  });

  it("emits insufficient_scope for a 403 challenge without creating a rendezvous row", async () => {
    stubFetch({});
    const { writer, events } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    bridge.emitInsufficientScope({
      serverId: "srv-1",
      toolCallId: "call-42",
      requiredScope: "read write admin",
      resourceMetadataUrl: "https://rs.example/.well-known",
    });

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "insufficient_scope",
        serverId: "srv-1",
        serverName: "GitHub",
        toolCallId: "call-42",
        requiredScope: "read write admin",
        resourceMetadataUrl: "https://rs.example/.well-known",
      }),
    );
    // Display-only: no JSON-RPC response is owed on the error path.
    expect(mutation).not.toHaveBeenCalled();
  });

  it("drops an insufficient_scope with no challenge fields rather than emit an empty notice", async () => {
    stubFetch({});
    const { writer, events } = makeWriter();
    const bridge = makeBridge();
    bridge.attachStreamWriter(writer);

    bridge.emitInsufficientScope({ serverId: "srv-1", toolCallId: "call-1" });

    expect(events()).toHaveLength(0);
  });
});
