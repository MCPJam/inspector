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
  cancelContinuation: async (_bearer: string, args: { continuationId: string }) => {
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
      submission: { continuationId: string; round: number; responsesBlobId: string };
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
        return { outcome: "cancelled", reason: "continuation already cancelled" };
      if (row.status !== "awaiting_input" || row.round !== options.submission.round)
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
        { uri: "ui://preview", mimeType: "text/html;profile=mcp-app", text: "<p>part</p>" },
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
      const identity = expected && { ...expected.owner, subject: expected.subject };
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
                  params: { mode: "form", message: "Pick a part", requestedSchema: schema },
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
type Shown = {
  continuationId: string;
  pluginModelOperation: { instanceToken: string; toolCallId: string; toolName: string };
  inputRequests: { key: string; pluginFormSourceToken: string }[];
};
let answers = 0;
function answer(shown: Shown, response: Record<string, unknown>) {
  const responsesBlobId = `answer-${++answers}`;
  shared.answers.set(responsesBlobId, { form: response });
  return { continuationId: shown.continuationId, round: 1, responsesBlobId };
}
const accept = { action: "accept", content: { part: "fixture://parts/bolt" } };
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

describe("an App-started form across replicas", () => {
  it("completes a form an App opened on another replica, until the App closes", async () => {
    const signal = new AbortController().signal;
    await replica();
    const opening = await import("../instances.js");
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
    const runtimeOn = async (instance: unknown) => {
      const { createPluginRequestRuntime } = await import("../request-runtime.js");
      return createPluginRequestRuntime(
        {} as never,
        {} as never,
        "fixture-bearer",
        { hostId: "host", serverId: "server" },
        instance as never,
        { ownerRef },
      );
    };
    // A: the App's call asks for a form; its sources are stored.
    const pending = (await (await runtimeOn(opened.instance)).runOwnedModern(
      authorization as never,
      "app-call",
      params,
      signal,
    )) as import("../invocation.js").PluginInvocationSuspension;
    const shown = pending.pending as unknown as Shown;
    // B: restores the App from the store and takes the answer.
    const answerOn = async () => {
      await replica();
      const { pluginInstances } = await import("../instances.js");
      const instance = await pluginInstances.getPersistent(opened.token, identity, signal);
      return (await runtimeOn(instance)).resumeMrtr(
        authorization as never,
        "app-call",
        params,
        answer(shown, accept),
        signal,
        pending,
      );
    };
    await expect(answerOn()).resolves.toMatchObject({ content: expect.any(Array) });
    expect(shared.upstream).toEqual([{ form: accept }]);
    // A second round on a closed App is refused before anything is sent.
    shared.continuations.get(shown.continuationId)!.status = "awaiting_input";
    await opening.pluginInstances.closePersistent(opened.token, identity, signal);
    await expect(answerOn()).rejects.toBeDefined();
    expect(shared.upstream).toHaveLength(1);
  });
});
