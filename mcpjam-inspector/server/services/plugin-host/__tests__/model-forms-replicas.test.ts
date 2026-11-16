import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Production runs several replicas with no sticky sessions. A model call
 * that opens a form suspends on the replica that ran the turn, and the
 * person's answer arrives as a new chat turn on any replica. Each "replica"
 * here is a fresh module graph (its own model-form adapter, form sources,
 * model owners and invoker). What real replicas share is shared here too:
 * - one control store, kept by the local store under the backend's rules;
 * - one receipt journal, following the backend's claim and write rules;
 * - one MRTR continuation table and the upstream server.
 * The real model-form adapter, invoker and owned-MRTR resume run in each
 * graph; only the network seams are stand-ins.
 */
type Leg = {
  round: number;
  fingerprint: string;
  state: string;
  valueJson?: string;
  errorCode?: string;
  continuationId?: string;
  pendingRound?: number;
};
type Receipt = {
  ownerHash: string;
  fingerprint: string;
  revision: string;
  writerHash: string;
  expiresAt: number;
  legs: Leg[];
};
const shared = vi.hoisted(() => ({
  store: undefined as unknown,
  invocation: undefined as unknown,
  receipts: new Map<string, Receipt>(),
  continuations: new Map<
    string,
    { status: string; round: number; state: Record<string, unknown> }
  >(),
  answers: new Map<string, Record<string, unknown>>(),
  upstream: [] as unknown[],
  prepareErrors: [] as unknown[],
  storeDown: false,
  /** Runs inside each admission read, as a slow admission wait would. */
  duringAdmission: undefined as undefined | (() => Promise<void>),
  /** Holds the upstream server's answer, as a slow wire would. */
  upstreamHold: undefined as undefined | Promise<void>,
  revision: "tool-v1",
}));

vi.mock("../invocation.js", async (original) => {
  shared.invocation ??= await original();
  return shared.invocation as object;
});
vi.mock("../local-store.js", async (original) => {
  const actual = await original<typeof import("../local-store.js")>();
  shared.store ??= new actual.LocalPluginControlStore();
  const store = shared.store as InstanceType<
    typeof actual.LocalPluginControlStore
  >;
  const { PluginInvocationError } = await import("../invocation.js");
  return {
    ...actual,
    localPluginControls: {
      handler: (path: string, unavailable: string) => {
        const handle = store.handler(path, unavailable);
        return async (body: unknown, signal: AbortSignal) => {
          if (shared.storeDown) throw new PluginInvocationError(unavailable);
          return handle(body, signal);
        };
      },
    },
  };
});
vi.mock("../../../utils/widget-resource-content.js", () => ({
  widgetResourceContent: () => ({ html: "<p>part</p>", mimeTypeValid: true }),
}));
vi.mock("../../../utils/ui-resource-meta.js", () => ({
  canSkipListingLookup: () => true,
  findListingMetaForUri: async () => undefined,
}));
vi.mock("../../evals/route-helpers.js", async (original) => ({
  ...(await original<typeof import("../../evals/route-helpers.js")>()),
  // The backend's pending fence: the continuation awaits this round's input.
  createConvexClient: () => ({
    query: async (_ref: unknown, args: { id: string; round: number }) => {
      const row = shared.continuations.get(args.id);
      return row?.status === "awaiting_input" && row.round === args.round
        ? { actorId: "actor", expiresAt: Date.now() + 60 * 60_000 }
        : null;
    },
  }),
}));
vi.mock("../receipt-store.js", async (original) => {
  const actual = await original<typeof import("../receipt-store.js")>();
  const { PluginInvocationError } = await import("../invocation.js");
  const fail = (code: string): never => {
    throw new PluginInvocationError(code);
  };
  const view = (row: Receipt) =>
    structuredClone({
      fingerprint: row.fingerprint,
      revision: row.revision,
      expiresAt: row.expiresAt,
      legs: row.legs,
    });
  return {
    ...actual,
    // The backend's receipt rules (`convex/pluginInvocationReceipts.ts`).
    createPluginInvocationReceiptPort: (
      owner: Parameters<typeof actual.pluginInvocationOwnerHash>[0],
      subject: string,
    ) => {
      const ownerHash = actual.pluginInvocationOwnerHash(owner, subject);
      const key = (id: string) => actual.pluginReceiptHash([ownerHash, id]);
      return {
        read: async (id: string) => {
          const row = shared.receipts.get(key(id));
          return row ? view(row) : null;
        },
        claim: async (
          id: string,
          input: {
            fingerprint: string;
            revision: string;
            writerHash: string;
            round: number;
            legFingerprint: string;
            continuationId?: string;
            dispatch?: true;
          },
        ) => {
          const row = shared.receipts.get(key(id));
          const state = input.dispatch ? "dispatched" : "reserved";
          if (!row) {
            if (
              input.round !== 0 ||
              input.continuationId !== undefined ||
              input.legFingerprint !== input.fingerprint
            )
              fail("CONTINUATION_RECEIPT_MISSING");
            const created: Receipt = {
              ownerHash,
              fingerprint: input.fingerprint,
              revision: input.revision,
              writerHash: input.writerHash,
              expiresAt: Date.now() + 30 * 60_000,
              legs: [{ round: 0, fingerprint: input.fingerprint, state }],
            };
            shared.receipts.set(key(id), created);
            return { claimed: true, receipt: view(created) };
          }
          if (
            row.ownerHash !== ownerHash ||
            row.fingerprint !== input.fingerprint
          )
            fail("INVOCATION_ID_REUSED");
          if (row.revision !== input.revision) fail("AUTHORIZATION_CHANGED");
          const existing = row.legs.find((leg) => leg.round === input.round);
          if (existing) {
            if (existing.fingerprint !== input.legFingerprint)
              fail("CONTINUATION_INPUT_REUSED");
            return { claimed: false, receipt: view(row) };
          }
          const previous = row.legs.at(-1)!;
          if (
            previous.state !== "suspended" ||
            previous.continuationId !== input.continuationId ||
            previous.pendingRound !== input.round
          )
            fail("CONTINUATION_DENIED");
          row.legs.push({
            round: input.round,
            fingerprint: input.legFingerprint,
            state,
          });
          row.writerHash = input.writerHash;
          return { claimed: true, receipt: view(row) };
        },
        write: async (
          id: string,
          input: Omit<Leg, "round" | "fingerprint"> & {
            writerHash: string;
            round: number;
          },
        ) => {
          const row = shared.receipts.get(key(id));
          if (!row || row.writerHash !== input.writerHash)
            fail("RECEIPT_WRITER_DENIED");
          const leg = row!.legs.at(-1)!;
          if (leg.round !== input.round) fail("RECEIPT_WRITER_DENIED");
          if (!["reserved", "dispatched"].includes(leg.state)) {
            if (leg.state !== input.state) fail("RECEIPT_SETTLED");
            return;
          }
          if (input.state === "refused") {
            if (input.round === 0) shared.receipts.delete(key(id));
            else row!.legs.pop();
            return;
          }
          if (
            ["completed", "suspended", "unavailable"].includes(input.state) &&
            leg.state !== "dispatched"
          )
            fail("RECEIPT_NOT_DISPATCHED");
          const { writerHash: _writer, ...next } = input;
          row!.legs[row!.legs.length - 1] = { ...leg, ...next };
        },
      };
    },
  };
});
vi.mock("../../../utils/mrtr-continuation-state.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/mrtr-continuation-state.js")
  >()),
  cancelContinuation: async (
    _bearer: string,
    args: { continuationId: string },
  ) => {
    const row = shared.continuations.get(args.continuationId);
    if (row) row.status = "cancelled";
    return { ok: true, status: "cancelled" };
  },
}));
vi.mock("../../../utils/mrtr-hosted-collector.js", async (original) => {
  const actual =
    await original<typeof import("../../../utils/mrtr-hosted-collector.js")>();
  return {
    ...actual,
    // Stores the operation like the durable continuation does and suspends.
    createHostedMrtrCollector:
      (options: {
        serverId: string;
        selectFormSchema: (params: Record<string, unknown>) => unknown;
        emit: (event: Record<string, unknown>) => void;
      }) =>
      async (args: {
        state: Record<string, unknown>;
        inputRequests: Record<string, { params: Record<string, unknown> }>;
      }) => {
        const continuationId = crypto.randomUUID();
        shared.continuations.set(continuationId, {
          status: "awaiting_input",
          round: 1,
          state: { ...args.state, pendingInputRequests: args.inputRequests },
        });
        options.emit({
          kind: "input_required",
          version: 1,
          continuationId,
          round: 1,
          serverId: options.serverId,
          method: "tools/call",
          operationLabel: "cad.reviewForm",
          inputRequests: Object.entries(args.inputRequests).map(
            ([key, request]) => ({
              key,
              mode: "form",
              message: request.params.message,
              requestedSchema: options.selectFormSchema(request.params),
            }),
          ),
          expiresAt: Date.now() + 10 * 60_000,
        });
        throw new actual.MrtrSuspendedSignal(continuationId, 1);
      },
    // The continuation's lease, then the caller's own prepare and wire legs.
    resumeMrtrContinuationLeg: async (options: {
      submission: {
        continuationId: string;
        round: number;
        responsesBlobId: string;
      };
      prepareLeg: (
        state: unknown,
        responses: unknown,
      ) => Promise<{ responses: unknown; commit: () => Promise<void> }>;
      driveLeg: (
        state: unknown,
        responses: unknown,
      ) => Promise<{ status: string; result?: unknown }>;
    }) => {
      const row = shared.continuations.get(options.submission.continuationId);
      if (!row) return { outcome: "expired" };
      if (row.status === "cancelled")
        return {
          outcome: "cancelled",
          reason: "continuation already cancelled",
        };
      if (
        row.status !== "awaiting_input" ||
        row.round !== options.submission.round
      )
        return { outcome: "failed", terminal: false };
      row.status = "resuming";
      let prepared;
      try {
        prepared = await options.prepareLeg(
          row.state,
          shared.answers.get(options.submission.responsesBlobId),
        );
        await prepared.commit();
      } catch (error) {
        shared.prepareErrors.push(error);
        row.status = "awaiting_input";
        return { outcome: "failed", terminal: false };
      }
      const leg = await options.driveLeg(row.state, prepared.responses);
      row.status = "completed";
      return { outcome: "completed", result: leg.result };
    },
  };
});
vi.mock("@mcpjam/sdk", async (original) => ({
  ...(await original<typeof import("@mcpjam/sdk")>()),
  // The upstream server: completes the call with the answers it received.
  resumeInputRequiredOperation: async (
    _client: unknown,
    _state: unknown,
    responses: unknown,
  ) => {
    shared.upstream.push(responses);
    await shared.upstreamHold;
    return {
      status: "complete",
      result: { content: [{ type: "text", text: JSON.stringify(responses) }] },
    };
  },
}));
/** The request runtime, registered per graph (`vi.doMock` in `replica`), so
 * each replica's owned MRTR, form sources and model owners are its own. A
 * hoisted factory is evaluated once and would share them across graphs. */
const fakeRuntime = async () => {
  const { createOwnedPluginMrtr } = await import("../owned-mrtr.js");
  const { assertPluginFormOwnerCurrent } = await import("../form-owner.js");
  const schema = {
    type: "object",
    properties: {
      part: {
        type: "string",
        format: "uri",
        "x-openai-input": {
          type: "resource",
          options: [
            {
              uri: "fixture://parts/bolt",
              name: "Bolt",
              _meta: {
                "openai/preview": {
                  target: { type: "mcp_app_tool", name: "cad.preview" },
                },
              },
            },
          ],
        },
      },
    },
  };
  const manager = {
    getInitializationInfo: () => ({ protocolVersion: "2026-07-28" }),
    getManagedClient: () => ({}),
    getServerConfig: () => ({ url: "https://fixture.invalid/mcp" }),
    assertMrtrToolOutputSchema: async () => undefined,
    readResource: async () => ({
      contents: [
        {
          uri: "ui://preview",
          mimeType: "text/html;profile=mcp-app",
          text: "<p>part</p>",
        },
      ],
    }),
  };
  const tool = (name: string) => ({
    revision: name === "cad.reviewForm" ? shared.revision : `${name}-v1`,
    hostRevision: "host-v1",
    bindingId: "binding",
    serverIdentity: { kind: "standalone", serverId: "server" },
    appToolsEnabled: true,
    tool: {
      name,
      inputSchema: { type: "object" },
      _meta: { ui: { resourceUri: "ui://preview" } },
    },
    manager,
  });
  return {
    createPluginRequestRuntime: (
      c: never,
      _admission: unknown,
      bearer: string,
      binding: { hostId: string; serverId: string },
      expected?: import("../instances.js").PluginFormOwner,
      options: {
        ownerRef?: import("../form-source-control.js").PluginFormOwnerRef;
        fenceOwner?: boolean;
      } = {},
    ) => {
      const admission = async () => {
        await shared.duringAdmission?.();
      };
      const identity = expected && {
        ...expected.owner,
        subject: expected.subject,
      };
      const mrtr =
        expected &&
        createOwnedPluginMrtr({
          c,
          bearer,
          projectId: "project",
          serverId: binding.serverId,
          manager: () => manager as never,
          // The runtime's own owner fence, around an admission read.
          assertCurrent: () =>
            assertPluginFormOwnerCurrent({
              owner: expected.owner,
              identity: identity!,
              ownerRef: options.ownerRef,
              fenceOwner: options.fenceOwner,
              admit: admission,
              signal: new AbortController().signal,
            }),
          sourceBinding: { hostId: binding.hostId, hostRevision: "host-v1" },
          identity: identity!,
          ownerRef: options.ownerRef,
        });
      return {
        resolve: async (
          name: string,
          _signal: AbortSignal,
          read: <T>(query: () => Promise<T>) => Promise<T> = (query) => query(),
        ) => {
          await read(admission);
          return tool(name);
        },
        resolveTools: async (names: string[]) => {
          await admission();
          return new Map(names.map((name) => [name, tool(name)]));
        },
        // The server asks for one form before it can finish the call.
        runOwnedModern: (
          auth: never,
          invocationId: string,
          params: { name: string; arguments?: Record<string, unknown> },
          signal: AbortSignal,
        ) =>
          mrtr!.execute(auth, invocationId, params, signal, () =>
            mrtr!.collector({
              state: {
                version: 1,
                opId: invocationId,
                round: 1,
                method: "tools/call",
                originalParams: params,
                requestState: "opaque",
                pendingInputRequests: {},
              },
              inputRequests: {
                form: {
                  method: "elicitation/create",
                  params: {
                    mode: "form",
                    message: "Pick a part",
                    requestedSchema: schema,
                  },
                },
              },
            } as never),
          ),
        collectOwnedMrtr: (args: never) => mrtr!.collector(args),
        resumeMrtr: (...args: Parameters<NonNullable<typeof mrtr>["resume"]>) =>
          mrtr!.resume(...args),
        release: async () => {},
        manager: () => manager,
      };
    },
  };
};

const identity = {
  actorId: "actor",
  projectId: "project",
  workspaceId: "workspace",
  subject: "verified-subject",
};
async function replica(who = identity) {
  vi.resetModules();
  vi.doMock("../request-runtime.js", fakeRuntime);
  const { createModelMrtrAdapter } = await import("../model-mrtr.js");
  const write = vi.fn();
  const adapter = createModelMrtrAdapter({
    c: {
      req: {
        raw: { signal: new AbortController().signal },
        header: () => "Bearer fixture",
      },
    } as never,
    admission: { ...who, revalidate: async () => undefined } as never,
    identity: who,
    bearer: "fixture-bearer",
    hostId: "host",
    hostRevision: "host-v1",
    serverIds: ["server"],
  });
  adapter.attachStreamWriter({ write });
  return { adapter, write };
}
const call = () => ({
  serverKey: "server",
  toolName: "cad.reviewForm",
  toolCallId: `call-${crypto.randomUUID()}`,
  input: { part: "bolt" },
});
type Shown = {
  continuationId: string;
  pluginModelOperation: {
    instanceToken: string;
    toolCallId: string;
    toolName: string;
  };
  inputRequests: { key: string; pluginFormSourceToken: string }[];
};
async function suspendOn(origin: Awaited<ReturnType<typeof replica>>) {
  await expect(
    origin.adapter.execute(call() as never, vi.fn()),
  ).rejects.toMatchObject({ code: "MRTR_SUSPENDED" });
  return origin.write.mock.calls.at(-1)![0].data as Shown;
}
let answers = 0;
function answer(shown: Shown, response: Record<string, unknown>) {
  const responsesBlobId = `answer-${++answers}`;
  shared.answers.set(responsesBlobId, { form: response });
  return { continuationId: shown.continuationId, round: 1, responsesBlobId };
}
const accept = { action: "accept", content: { part: "fixture://parts/bolt" } };
const resume = (
  on: Awaited<ReturnType<typeof replica>>,
  shown: Shown,
  submission: ReturnType<typeof answer>,
) =>
  on.adapter.resume(shown.pluginModelOperation as never, submission, "server");

beforeEach(() => {
  shared.receipts.clear();
  shared.continuations.clear();
  shared.answers.clear();
  shared.upstream.length = 0;
  shared.prepareErrors.length = 0;
  shared.storeDown = false;
  shared.duringAdmission = undefined;
  shared.upstreamHold = undefined;
  shared.revision = "tool-v1";
});

describe("an AI-triggered form across replicas", () => {
  it("is answered on another replica and runs the tool once", async () => {
    const shown = await suspendOn(await replica());
    expect(shown.inputRequests[0]!.pluginFormSourceToken).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    const submission = answer(shown, accept);
    expect(await resume(await replica(), shown, submission)).toMatchObject({
      kind: "complete",
    });
    expect(shared.prepareErrors).toEqual([]);
    expect(shared.upstream).toEqual([{ form: accept }]);
    // Resent to a third replica: the first result, and no second run.
    expect(await resume(await replica(), shown, submission)).toMatchObject({
      kind: "complete",
    });
    expect(shared.upstream).toHaveLength(1);
  });

  it("ends once when it is declined on another replica", async () => {
    const shown = await suspendOn(await replica());
    expect(
      await resume(
        await replica(),
        shown,
        answer(shown, { action: "decline" }),
      ),
    ).toMatchObject({ kind: "complete" });
    expect(shared.upstream).toEqual([{ form: { action: "decline" } }]);
  });

  it("runs the tool once when the same answer races on two replicas", async () => {
    const shown = await suspendOn(await replica());
    const submission = answer(shown, accept);
    const [b, c] = [await replica(), await replica()];
    const results = await Promise.allSettled([
      resume(b, shown, submission),
      resume(c, shown, submission),
    ]);
    expect(shared.upstream).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled")).not.toHaveLength(0);
    // The loser either replays the result or, while the winner is still on
    // the wire, reports that it can't confirm the outcome.
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({
          code: "INVOCATION_OUTCOME_UNKNOWN",
        });
  });

  it("refuses a different answer for a round another replica already took", async () => {
    const shown = await suspendOn(await replica());
    await resume(await replica(), shown, answer(shown, accept));
    await expect(
      resume(await replica(), shown, answer(shown, { action: "decline" })),
    ).rejects.toMatchObject({ code: "CONTINUATION_INPUT_REUSED" });
    expect(shared.upstream).toHaveLength(1);
  });

  it("ends as cancelled when it was withdrawn on another replica", async () => {
    const shown = await suspendOn(await replica());
    shared.continuations.get(shown.continuationId)!.status = "cancelled";
    await expect(
      resume(await replica(), shown, answer(shown, accept)),
    ).rejects.toMatchObject({ code: "CONTINUATION_CANCELLED" });
    expect(shared.upstream).toEqual([]);
  });

  it("reports an unknown outcome, never a second run, after a replica stops on the wire", async () => {
    const shown = await suspendOn(await replica());
    const submission = answer(shown, accept);
    // B sends the answer and never hears back, as a replica that died would.
    shared.upstreamHold = new Promise(() => {});
    void resume(await replica(), shown, submission).catch(() => undefined);
    await vi.waitFor(() => expect(shared.upstream).toHaveLength(1));
    shared.upstreamHold = undefined;
    await expect(
      resume(await replica(), shown, submission),
    ).rejects.toMatchObject({ code: "INVOCATION_OUTCOME_UNKNOWN" });
    expect(shared.upstream).toHaveLength(1);
  });

  it("is not shown, and is withdrawn, when the store can't keep it", async () => {
    const origin = await replica();
    shared.storeDown = true;
    await expect(
      origin.adapter.execute(call() as never, vi.fn()),
    ).rejects.toMatchObject({ code: "FORM_NOT_SAVED" });
    expect(origin.write).not.toHaveBeenCalled();
    expect([...shared.continuations.values()].map((row) => row.status)).toEqual(
      ["cancelled"],
    );
  });

  it("refuses an answer while the store is down, and takes it once it's back", async () => {
    const shown = await suspendOn(await replica());
    const submission = answer(shown, accept);
    shared.storeDown = true;
    await expect(
      resume(await replica(), shown, submission),
    ).rejects.toMatchObject({ code: "FORM_STORE_UNAVAILABLE" });
    expect(shared.upstream).toEqual([]);
    shared.storeDown = false;
    expect(await resume(await replica(), shown, submission)).toMatchObject({
      kind: "complete",
    });
    expect(shared.upstream).toHaveLength(1);
  });

  it("refuses an answer whose form closed during the admission wait", async () => {
    const shown = await suspendOn(await replica());
    const b = await replica();
    const { createPluginInstanceControlPort } =
      await import("../instance-store.js");
    shared.duringAdmission = async () => {
      shared.duringAdmission = undefined;
      await createPluginInstanceControlPort(identity)!.close(
        shown.pluginModelOperation.instanceToken,
        new AbortController().signal,
      );
    };
    await expect(resume(b, shown, answer(shown, accept))).rejects.toMatchObject(
      {
        code: "MODEL_FORM_UNAVAILABLE",
      },
    );
    expect(shared.upstream).toEqual([]);
  });

  it("ends on every replica at the lease it was stored with, even during an admission wait", async () => {
    // Rule 5: the replica that showed the form holds it no longer than the
    // store does. Rule 2: expiry during the wait refuses what follows it.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const origin = await replica();
      const shown = await suspendOn(origin);
      const other = await replica();
      shared.duringAdmission = async () => {
        shared.duringAdmission = undefined;
        vi.setSystemTime(Date.now() + 29 * 60_000);
      };
      for (const on of [other, origin])
        await expect(
          resume(on, shown, answer(shown, accept)),
        ).rejects.toMatchObject({ code: "MODEL_FORM_UNAVAILABLE" });
      expect(shared.upstream).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["another user", { actorId: "other-actor" }],
    ["the same user with another credential", { subject: "second-credential" }],
    ["another workspace", { workspaceId: "other-workspace" }],
  ])("refuses %s without ending the owner's form", async (_who, change) => {
    const shown = await suspendOn(await replica());
    await expect(
      resume(
        await replica({ ...identity, ...change }),
        shown,
        answer(shown, accept),
      ),
    ).rejects.toMatchObject({ code: "MODEL_FORM_UNAVAILABLE" });
    expect(shared.upstream).toEqual([]);
    expect(
      await resume(await replica(), shown, answer(shown, accept)),
    ).toMatchObject({ kind: "complete" });
  });

  it("refuses an answer after the tool's revision changed, without ending the form", async () => {
    const shown = await suspendOn(await replica());
    shared.revision = "tool-v2";
    await expect(
      resume(await replica(), shown, answer(shown, accept)),
    ).rejects.toMatchObject({ code: "MODEL_FORM_UNAVAILABLE" });
    expect(shared.upstream).toEqual([]);
    shared.revision = "tool-v1";
    expect(
      await resume(await replica(), shown, answer(shown, accept)),
    ).toMatchObject({ kind: "complete" });
  });

  it("serves the form's pickers on another replica, to its owner only", async () => {
    const shown = await suspendOn(await replica());
    const parent = {
      kind: "mrtr" as const,
      id: shown.continuationId,
      round: 1,
      inputRequestKey: "form",
    };
    const authority = async (who = identity) => {
      await replica(who);
      const { createPluginFormAuthority } = await import("../form-service.js");
      const { createPluginRequestRuntime } =
        await import("../request-runtime.js");
      return createPluginFormAuthority({
        actor: who,
        bearer: "fixture-bearer",
        sourceToken: shown.inputRequests[0]!.pluginFormSourceToken,
        parent,
        signal: new AbortController().signal,
        runtime: (instance) =>
          createPluginRequestRuntime(
            {} as never,
            {} as never,
            "fixture-bearer",
            { hostId: "host", serverId: "server" },
            instance,
          ),
      });
    };
    const served = await authority();
    expect(served.source.requestedSchema).toMatchObject({ type: "object" });
    await expect(served.checkPending()).resolves.toBeUndefined();
    await expect(
      authority({ ...identity, subject: "second-credential" }),
    ).rejects.toMatchObject({ code: "FORM_SOURCE_UNAVAILABLE" });
    // Once the round is answered anywhere, its pickers are refused everywhere.
    await resume(await replica(), shown, answer(shown, accept));
    await expect(served.checkPending()).rejects.toMatchObject({
      code: "FORM_PREVIEW_UNAVAILABLE",
    });
  });

  it("refuses the same user's second credential even where the form is held", async () => {
    const shown = await suspendOn(await replica());
    // Same module graph as the replica that showed the form.
    const { createPluginFormAuthority } = await import("../form-service.js");
    await expect(
      createPluginFormAuthority({
        actor: { ...identity, subject: "second-credential" },
        bearer: "fixture-bearer",
        sourceToken: shown.inputRequests[0]!.pluginFormSourceToken,
        parent: {
          kind: "mrtr",
          id: shown.continuationId,
          round: 1,
          inputRequestKey: "form",
        },
        signal: new AbortController().signal,
        runtime: () => {
          throw new Error("no runtime for a refused caller");
        },
      }),
    ).rejects.toMatchObject({ code: "FORM_SOURCE_UNAVAILABLE" });
  });

  it("refuses a form step whose owner closed during its admission wait", async () => {
    const shown = await suspendOn(await replica());
    await replica();
    const { pluginModelForms } = await import("../model-form-control.js");
    const { assertPluginFormOwnerCurrent } = await import("../form-owner.js");
    const { createPluginInstanceControlPort } =
      await import("../instance-store.js");
    const token = shown.pluginModelOperation.instanceToken;
    const signal = new AbortController().signal;
    const form = await pluginModelForms.restore(token, identity, signal);
    const step = (admit: () => Promise<void>) =>
      assertPluginFormOwnerCurrent({
        owner: form.instance.owner,
        identity,
        ownerRef: { kind: "model-form", token },
        admit,
        signal,
      });
    await expect(step(async () => {})).resolves.toBeUndefined();
    await expect(
      step(() =>
        createPluginInstanceControlPort(identity)!
          .close(token, signal)
          .then(() => {}),
      ),
    ).rejects.toMatchObject({ code: "MODEL_FORM_UNAVAILABLE" });
  });

  it("completes a form an App opened on another replica, until the App closes", async () => {
    const app = await openApp();
    const { pending, shown } = await app.ask();
    await expect(app.answerElsewhere(pending)).resolves.toMatchObject({
      content: expect.any(Array),
    });
    expect(shared.upstream).toEqual([{ form: accept }]);
    // A second round on a closed App is refused before anything is sent.
    shared.continuations.get(shown.continuationId)!.status = "awaiting_input";
    await app.opening.pluginInstances.closePersistent(
      app.opened.token,
      identity,
      app.signal,
    );
    await expect(app.answerElsewhere(pending)).rejects.toMatchObject({
      code: "INSTANCE_UNAVAILABLE",
    });
    expect(shared.upstream).toHaveLength(1);
  });

  it("keeps a form an App opened when one replica's copy of the App reaches the lease it last read", async () => {
    // Rule 5: a replica drops its copy at the lease it last read and never
    // closes the row, so a lease another replica renewed still holds.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now();
      const app = await openApp();
      vi.setSystemTime(start + 25 * 60_000);
      const { pending } = await app.ask();
      await replica();
      const renewing = await import("../instances.js");
      await renewing.pluginInstances.renewPersistent(
        app.opened.token,
        identity,
        app.signal,
        async () => {},
      );
      vi.setSystemTime(start + 31 * 60_000);
      // The replica that showed the form drops its copy of the App, and with
      // it its copies of the form's sources.
      expect(() =>
        app.opening.pluginInstances.get(app.opened.token, identity),
      ).toThrow();
      await expect(app.answerElsewhere(pending)).resolves.toMatchObject({
        content: expect.any(Array),
      });
      expect(shared.upstream).toEqual([{ form: accept }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens an App preview inside the form on one replica and serves it on another", async () => {
    const shown = await suspendOn(await replica());
    const target = { type: "mcp_app_tool" as const, name: "cad.preview" };
    const options = async (who = identity) => {
      const { createPluginRequestRuntime } =
        await import("../request-runtime.js");
      return {
        actor: who,
        bearer: "fixture-bearer",
        sourceToken: shown.inputRequests[0]!.pluginFormSourceToken,
        parent: {
          kind: "mrtr" as const,
          id: shown.continuationId,
          round: 1,
          inputRequestKey: "form",
        },
        signal: new AbortController().signal,
        runtime: (instance: never) =>
          createPluginRequestRuntime(
            {} as never,
            {} as never,
            "fixture-bearer",
            { hostId: "host", serverId: "server" },
            instance,
          ),
      };
    };
    await replica();
    const opening = await import("../form-app-preview.js");
    const opened = await opening.openPluginFormAppPreview({
      ...(await options()),
      target,
    });
    await replica();
    const serving = await import("../form-app-preview.js");
    const served = await serving.getPluginFormApp({
      ...(await options()),
      token: opened.instanceToken,
    });
    expect(served.child.operationId).toBe(opened.operationId);
    expect(served.target).toEqual(target);
    await replica({ ...identity, subject: "second-credential" });
    const foreign = await import("../form-app-preview.js");
    await expect(
      foreign.getPluginFormApp({
        ...(await options({ ...identity, subject: "second-credential" })),
        token: opened.instanceToken,
      }),
    ).rejects.toMatchObject({ code: "FORM_PREVIEW_UNAVAILABLE" });
  });
});

/** Opens an App on a fresh replica, whose call then asks for a form there. */
async function openApp() {
  const signal = new AbortController().signal;
  await replica();
  const opening = await import("../instances.js");
  const { createPluginRequestRuntime } = await import("../request-runtime.js");
  const opened = await opening.pluginInstances.openActivationPersistent(
    identity,
    {
      runtime: "codex",
      hostId: "host",
      hostRevision: "host-v1",
      serverId: "server",
      bindingId: "binding",
      resourceUri: "ui://fixture",
      serverIdentity: { kind: "standalone", serverId: "server" },
      activation: {
        selector: { kind: "thread", threadId: "thread" },
        toolName: "cad.reviewForm",
        revision: "tool-v1",
      },
    },
    signal,
  );
  const ownerRef = { kind: "app" as const, token: opened.token };
  const authorization = {
    owner: opened.instance.owner,
    origin: "app" as const,
    revision: "tool-v1",
    tool: { name: "cad.reviewForm" },
    enabled: true,
    requiresApproval: false,
    allowedOrigins: ["app" as const],
  };
  const params = { name: "cad.reviewForm", arguments: {} };
  const runtime = (
    create: typeof createPluginRequestRuntime,
    instance: unknown,
  ) =>
    create(
      {} as never,
      {} as never,
      "fixture-bearer",
      { hostId: "host", serverId: "server" },
      instance as never,
      { ownerRef },
    );
  return {
    signal,
    opening,
    opened,
    /** The App's call, on the replica that opened it, asks for a form. */
    ask: async () => {
      const pending = (await runtime(
        createPluginRequestRuntime,
        opened.instance,
      ).runOwnedModern(
        authorization as never,
        "app-call",
        params,
        signal,
      )) as import("../invocation.js").PluginInvocationSuspension;
      return { pending, shown: pending.pending as unknown as Shown };
    },
    /** A fresh replica restores the App from the store and takes the answer. */
    answerElsewhere: async (
      pending: import("../invocation.js").PluginInvocationSuspension,
    ) => {
      await replica();
      const { pluginInstances } = await import("../instances.js");
      const { createPluginRequestRuntime: create } =
        await import("../request-runtime.js");
      const instance = await pluginInstances.getPersistent(
        opened.token,
        identity,
        signal,
      );
      return runtime(create, instance).resumeMrtr(
        authorization as never,
        "app-call",
        params,
        answer(pending.pending as unknown as Shown, accept),
        signal,
        pending,
      );
    },
  };
}
