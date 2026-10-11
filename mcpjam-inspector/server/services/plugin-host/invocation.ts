import {
  INVOCATION_RECEIPT_VALUE_BYTES,
  INVOCATION_RECEIPT_MAX_ROUNDS,
} from "../../../shared/plugin-invocation-receipts.js";
import { createHash, randomBytes } from "node:crypto";
import type {
  DurableInvocationReceipt,
  PluginInvocationReceiptPort,
} from "./receipt-store.js";
import {
  decideToolPolicyFromSnapshot,
  type ToolPolicySnapshot,
} from "@mcpjam/sdk/contract";
import { getToolVisibility } from "@mcpjam/sdk/widget-runtime";
import { stripPluginResourcePath } from "./resource-metadata.js";
import { isPluginMentionTool } from "../../../shared/plugin-mentions.js";
import {
  describePluginError,
  pluginDiagnostic,
  type PluginDiagnostic,
} from "../../../shared/plugin-diagnostics.js";

export const PLUGIN_INVOCATION_ORIGINS = [
  "model",
  "app",
  "entrypoint",
  "quick-action",
  "settings",
  "mention",
  "preview",
] as const;
export type PluginInvocationOrigin = (typeof PLUGIN_INVOCATION_ORIGINS)[number];

/** Constructed by an authenticated session/run resolver, never from app metadata. */
export interface TrustedInvocationOwner {
  actorId: string;
  projectId: string;
  workspaceId: string;
  instanceId: string;
  generation: number;
  serverId: string;
  bindingId: string;
  placement: "interactive" | "ephemeral-run";
  runId?: string;
}
export interface PluginToolCallParams extends Record<string, unknown> {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}
export interface AuthorizedInvocation {
  /** Revision of the live permission, target, host and approval configuration. */
  revision: string;
  owner: TrustedInvocationOwner;
  enabled: boolean;
  tool: { name: string; _meta?: Record<string, unknown> };
  allowedOrigins: readonly PluginInvocationOrigin[];
  toolPolicy?: ToolPolicySnapshot;
  requiresApproval: boolean;
}
export type ResolvedInvocationContext = AuthorizedInvocation & {
  origin: PluginInvocationOrigin;
};
export interface PluginInvocationPorts {
  /** Inspector-owned durable receipts; never a caller-authored JSON snapshot. */
  receipts?: PluginInvocationReceiptPort;
  /** Fresh request ports for one owned continuation leg; never retained by a receipt. */
  continuation?: {
    submission: PluginContinuationSubmission;
    resume: (
      authorization: ResolvedInvocationContext,
      params: PluginToolCallParams,
      signal: AbortSignal,
    ) => Promise<unknown>;
  };
  /** Reuses existing actor/project/target authorization and feature-gate resolution. */
  authorize: (
    owner: TrustedInvocationOwner,
    origin: PluginInvocationOrigin,
    params: PluginToolCallParams,
    signal: AbortSignal,
  ) => Promise<AuthorizedInvocation>;
  /** Existing approval service; approval is bound to this invocation and revision. */
  approve: (
    authorization: ResolvedInvocationContext,
    invocationId: string,
    params: PluginToolCallParams,
    signal: AbortSignal,
  ) => Promise<boolean>;
  /** Existing metering/admission service, called once per accepted operation. */
  admit: (
    authorization: ResolvedInvocationContext,
    invocationId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Host-owned resource/trace metadata; apps cannot supply these values.
   * Omit when this adapter has no metadata service, rather than inventing a wait. */
  metadata?: (
    authorization: ResolvedInvocationContext,
    params: PluginToolCallParams,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  /** Receives complete supported params, including sanitized/derived metadata. */
  execute: (
    authorization: ResolvedInvocationContext,
    params: PluginToolCallParams,
    signal: AbortSignal,
    invocationId?: string,
  ) => Promise<unknown>;
  /** Only an authoritative server failure can classify a dispatched error as known. */
  classifyFailure: (error: unknown) => "failed" | "unknown";
  /** Run `work` once this request's response is decided, off its critical
   * path. When present, the final receipt of a call with a known result is
   * written through it (see `AuthorizedToolInvoker.persistLater`); without
   * it that write gates the result, as before. */
  defer?: (work: () => Promise<void>) => void;
}

/** How many times a deferred final receipt write is tried, and the wait
 * before each retry. Only a transport failure is retried. */
export const PLUGIN_DEFERRED_RECEIPT_ATTEMPTS = 3;
const DEFERRED_RECEIPT_RETRY_MS = 250;
const DEFERRED_RECEIPT_TIMEOUT_MS = 15_000;

export interface PluginContinuationSubmission {
  continuationId: string;
  round: number;
  responsesBlobId: string;
}

const noAdmissionWork = new WeakSet<PluginInvocationPorts["admit"]>();

/** For adapters whose fresh authorization already performs admission and which
 * have no additional billing/metering work. Only this effect-free factory can
 * omit the extra post-admission lookup; arbitrary callbacks retain their fence. */
export function createPluginAdmissionNoop(): PluginInvocationPorts["admit"] {
  const admit: PluginInvocationPorts["admit"] = async () => {};
  noAdmissionWork.add(admit);
  return admit;
}

/** Only trusted dispatch code can suspend an invocation; tool JSON cannot do so. */
export class PluginInvocationSuspension {
  readonly pending: Readonly<Record<string, unknown>> & {
    continuationId: string;
    round: number;
  };
  constructor(
    pending: Record<string, unknown> & {
      continuationId: string;
      round: number;
    },
  ) {
    if (
      !pending.continuationId ||
      pending.continuationId.length > 256 ||
      !Number.isSafeInteger(pending.round) ||
      pending.round < 1 ||
      Buffer.byteLength(JSON.stringify(pending)) > 128 * 1024
    )
      throw new PluginInvocationError("INVALID_INVOCATION_SUSPENSION");
    this.pending = Object.freeze(structuredClone(pending));
  }
}

interface InvocationReceipt {
  fingerprint: string;
  result: Promise<unknown>;
  revision?: string;
  pending?: PluginInvocationSuspension;
  continuations: Map<number, { fingerprint: string; result: Promise<unknown> }>;
  recovering?: Promise<void>;
  /** The settled value was dropped to bound memory; fingerprint and revision
   * remain so the effect is never repeated. Replay reads the durable receipt. */
  evicted?: boolean;
  /** Failed before dispatch (denied, aborted, admission timeout): nothing ran,
   * so a retry with the same ID starts over instead of replaying the failure. */
  retryable?: boolean;
}

/**
 * Bounded memory for settled tool results kept for idempotent replay.
 * Budgets are per verified actor and process-wide; the oldest values are
 * dropped first. Fingerprints, revisions and outcome states are kept, so an
 * evicted call is never re-executed: its replay comes from the durable
 * receipt, or is refused with INVOCATION_RESULT_EXPIRED.
 */
export class PluginRetainedResultBudget {
  private readonly entries = new Map<
    object,
    { actor: string; bytes: number; evict: () => void }
  >();
  private readonly actors = new Map<string, number>();
  private total = 0;
  constructor(
    readonly perActorBytes = 16 * 1024 * 1024,
    readonly totalBytes = 128 * 1024 * 1024,
  ) {}

  retain(handle: object, actor: string, bytes: number, evict: () => void) {
    this.release(handle);
    if (bytes > this.perActorBytes) {
      evict();
      return;
    }
    this.entries.set(handle, { actor, bytes, evict });
    this.actors.set(actor, (this.actors.get(actor) ?? 0) + bytes);
    this.total += bytes;
    for (const [key, entry] of this.entries) {
      if ((this.actors.get(actor) ?? 0) <= this.perActorBytes) break;
      if (entry.actor !== actor) continue;
      this.drop(key, true);
    }
    for (const key of this.entries.keys()) {
      if (this.total <= this.totalBytes) break;
      this.drop(key, true);
    }
  }

  /** Forget a value without evicting it (its owner closed). */
  release(handle: object) {
    this.drop(handle, false);
  }

  private drop(handle: object, evict: boolean) {
    const entry = this.entries.get(handle);
    if (!entry) return;
    this.entries.delete(handle);
    this.total -= entry.bytes;
    const remaining = (this.actors.get(entry.actor) ?? 0) - entry.bytes;
    if (remaining > 0) this.actors.set(entry.actor, remaining);
    else this.actors.delete(entry.actor);
    if (evict) entry.evict();
  }

  usage(actor?: string) {
    return actor === undefined ? this.total : (this.actors.get(actor) ?? 0);
  }
}
export const pluginRetainedResults = new PluginRetainedResultBudget();

/** A JSON-RPC error response is the server's authoritative answer: the call
 * is known to have failed. Local transport failures (timeouts, closed or
 * unsent connections, malformed results) leave the outcome unknown. */
export function classifyPluginToolFailure(error: unknown): "failed" | "unknown" {
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "number" &&
    Number.isInteger(code) &&
    code !== -32000 &&
    code !== -32001
    ? "failed"
    : "unknown";
}

const approximateBytes = (value: unknown) => {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
};

export class PluginInvocationError extends Error {
  /** Entries for the client's Logs panel, returned with the refusal. */
  diagnostics?: PluginDiagnostic[];
  constructor(
    readonly code: string,
    readonly outcomeUnknown = false,
  ) {
    super(code);
    this.name = "PluginInvocationError";
  }
}

/** Attach one described Logs entry, for the code's shared description, to a
 * refusal the client should see in its Logs panel. */
export function withPluginDiagnostic<T extends PluginInvocationError>(
  error: T,
  serverId: string,
  title: string,
  level: PluginDiagnostic["level"] = "warning",
): T {
  error.diagnostics = [
    {
      ...pluginDiagnostic(
        level,
        error.code,
        title,
        describePluginError(error.code) ?? error.code,
      ),
      serverId,
    },
  ];
  return error;
}

/** Proven pre-wire refusal may be retried explicitly, using the same receipt. */
export class PluginContinuationRefused extends PluginInvocationError {
  constructor(code = "CONTINUATION_REFUSED") {
    super(code);
  }
}

/** The continuation ended before this leg reached the wire (it expired or was
 * cancelled): a known, final outcome, never an uncertain effect. */
export class PluginContinuationTerminal extends PluginInvocationError {
  constructor(
    code:
      | "CONTINUATION_EXPIRED"
      | "CONTINUATION_CANCELLED"
      | "PLUGIN_FORMS_DISABLED",
  ) {
    super(code);
  }
}

const fail = (code: string, unknown = false): never => {
  throw new PluginInvocationError(code, unknown);
};
const ownerKey = (owner: TrustedInvocationOwner) =>
  JSON.stringify([
    owner.actorId,
    owner.projectId,
    owner.workspaceId,
    owner.instanceId,
    owner.generation,
    owner.serverId,
    owner.bindingId,
    owner.placement,
    owner.runId ?? null,
  ]);
const reserved = (key: string) =>
  key.startsWith("mcpjam/") ||
  [
    "openai/resource.path",
    "_serverId",
    "traceparent",
    "tracestate",
    "baggage",
    "io.modelcontextprotocol/protocolVersion",
    "io.modelcontextprotocol/clientCapabilities",
  ].includes(key);

/** Abort the wait even when a slow adapter returns after its owner closes. */
async function awaitOwned<T>(
  signal: AbortSignal,
  effect: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return effect();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Sanitize only owned keys; preserve every other request field and metadata value. */
export function sanitizePluginToolParams(
  params: PluginToolCallParams,
): PluginToolCallParams {
  const cloned = structuredClone(params);
  if (cloned._meta) {
    cloned._meta = Object.fromEntries(
      Object.entries(stripPluginResourcePath(cloned._meta)).filter(
        ([key]) => !reserved(key),
      ),
    );
  }
  return cloned;
}

/**
 * Common live service for all invocation origins. Ports retain existing auth,
 * approval and billing authorities; this class orders and revalidates them.
 * Request ports may compose trusted durable receipts. Receipt recovery never
 * grants live instance/source authority or repeats an uncertain dispatch.
 */
export class AuthorizedToolInvoker {
  private readonly owner: TrustedInvocationOwner;
  private readonly receipts = new Map<string, InvocationReceipt>();
  private readonly active = new Set<AbortController>();
  private closed = false;

  constructor(
    owner: TrustedInvocationOwner,
    private readonly ports: PluginInvocationPorts,
    private readonly maxOperations = 2048,
    private readonly observe?: (
      invocationId: string,
      kind:
        | "call-started"
        | "call-completed"
        | "call-denied"
        | "call-unknown"
        | "call-suspended"
        | "call-continued",
      origin: PluginInvocationOrigin,
    ) => void,
    private readonly budget: PluginRetainedResultBudget = pluginRetainedResults,
  ) {
    this.init(owner, maxOperations);
    this.owner = structuredClone(owner);
  }

  private init(owner: TrustedInvocationOwner, maxOperations: number) {
    if (
      !owner.actorId ||
      !owner.projectId ||
      !owner.workspaceId ||
      !owner.instanceId ||
      !owner.serverId ||
      !owner.bindingId ||
      !Number.isSafeInteger(owner.generation) ||
      owner.generation < 1 ||
      !["interactive", "ephemeral-run"].includes(owner.placement) ||
      (owner.placement === "ephemeral-run" && !owner.runId) ||
      !Number.isSafeInteger(maxOperations) ||
      maxOperations < 1 ||
      maxOperations > 2048
    )
      fail("INVALID_INVOCATION_OWNER");
  }

  invoke(
    origin: PluginInvocationOrigin,
    invocationId: string,
    params: PluginToolCallParams,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new PluginInvocationError("INSTANCE_CLOSED"));
    if (
      !PLUGIN_INVOCATION_ORIGINS.includes(origin) ||
      !invocationId ||
      invocationId.length > 128 ||
      !params ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      typeof params.name !== "string" ||
      !params.name ||
      (params.arguments !== undefined &&
        (!params.arguments ||
          typeof params.arguments !== "object" ||
          Array.isArray(params.arguments))) ||
      (params._meta !== undefined &&
        (!params._meta ||
          typeof params._meta !== "object" ||
          Array.isArray(params._meta)))
    )
      return Promise.reject(new PluginInvocationError("INVALID_INVOCATION"));
    let snapshot: PluginToolCallParams, fingerprint: string;
    try {
      snapshot = structuredClone(params);
      const serialized = JSON.stringify([origin, snapshot]);
      if (new TextEncoder().encode(serialized).byteLength > 512 * 1024)
        fail("INVOCATION_TOO_LARGE");
      fingerprint = createHash("sha256").update(serialized).digest("hex");
    } catch (error) {
      return Promise.reject(
        error instanceof PluginInvocationError
          ? error
          : new PluginInvocationError("INVALID_INVOCATION"),
      );
    }
    const existing = this.receipts.get(invocationId);
    const continuation = this.ports.continuation;
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return Promise.reject(
          new PluginInvocationError("INVOCATION_ID_REUSED"),
        );
      if (existing.evicted && !continuation)
        return this.recoverEvicted(
          origin,
          invocationId,
          snapshot,
          existing,
          signal,
        );
      if (existing.recovering)
        return awaitOwned(
          signal ?? new AbortController().signal,
          () => existing.recovering!,
        ).then(() => this.invoke(origin, invocationId, params, signal));
      if (!continuation)
        return this.replay(origin, snapshot, existing, existing.result, signal);
      return this.continue(
        origin,
        invocationId,
        snapshot,
        existing,
        continuation,
        signal,
      );
    }
    if (continuation && !this.ports.receipts)
      return Promise.reject(
        new PluginInvocationError("CONTINUATION_RECEIPT_MISSING"),
      );
    if (this.receipts.size >= this.maxOperations)
      return Promise.reject(new PluginInvocationError("INVOCATION_LIMIT"));
    const receipt: InvocationReceipt = {
      fingerprint,
      result: undefined!,
      continuations: new Map(),
    };
    let recovered: (() => void) | undefined;
    let recoveryFailed: ((error: unknown) => void) | undefined;
    if (continuation) {
      receipt.recovering = new Promise<void>((resolve, reject) => {
        recovered = resolve;
        recoveryFailed = reject;
      });
      void receipt.recovering.catch(() => {});
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    this.active.add(controller);
    // Publish the receipt before invoking any port, including synchronous mocks.
    const result = Promise.resolve()
      .then(async () => {
        this.observation(invocationId, "call-started", origin);
        try {
          let output: unknown;
          if (continuation) {
            const saved = await this.ports.receipts!.read(
              invocationId,
              controller.signal,
            );
            if (!saved) fail("CONTINUATION_RECEIPT_MISSING");
            this.restore(receipt, saved!);
            const next = this.continue(
              origin,
              invocationId,
              snapshot,
              receipt,
              continuation,
              controller.signal,
            );
            receipt.recovering = undefined;
            recovered?.();
            output = await next;
          } else
            output = await this.run(
              origin,
              invocationId,
              snapshot,
              controller.signal,
              receipt,
            );
          this.observation(
            invocationId,
            output instanceof PluginInvocationSuspension
              ? "call-suspended"
              : "call-completed",
            origin,
          );
          return output;
        } catch (error) {
          recoveryFailed?.(error);
          this.observation(
            invocationId,
            error instanceof PluginInvocationError && error.outcomeUnknown
              ? "call-unknown"
              : "call-denied",
            origin,
          );
          throw error;
        }
      })
      .finally(() => {
        this.active.delete(controller);
        signal?.removeEventListener("abort", abort);
      });
    receipt.result = result;
    this.receipts.set(invocationId, receipt);
    result.then(
      (value) => this.retainSettled(invocationId, receipt, value),
      () => {
        // Nothing ran: a retry with this ID asks again (approval included).
        if (receipt.retryable && this.receipts.get(invocationId) === receipt)
          this.receipts.delete(invocationId);
      },
    );
    return result;
  }

  /** Account a settled value against the per-actor memory budget. */
  private retainSettled(
    invocationId: string,
    receipt: InvocationReceipt,
    value: unknown,
  ) {
    if (
      this.closed ||
      value instanceof PluginInvocationSuspension ||
      receipt.pending ||
      this.receipts.get(invocationId) !== receipt
    )
      return;
    this.budget.retain(
      receipt,
      this.owner.actorId,
      approximateBytes(value),
      () => {
        receipt.evicted = true;
        // Keep the identity and outcome; drop only the value.
        receipt.result = Promise.resolve(undefined);
      },
    );
  }

  /** Replay a call whose value was evicted, from its durable receipt only. */
  private async recoverEvicted(
    origin: PluginInvocationOrigin,
    invocationId: string,
    params: PluginToolCallParams,
    receipt: InvocationReceipt,
    signal?: AbortSignal,
  ) {
    const saved = this.ports.receipts
      ? await awaitOwned(signal ?? new AbortController().signal, () =>
          this.ports.receipts!.read(invocationId, signal ?? new AbortController().signal),
        )
      : null;
    const last = saved?.legs.at(-1);
    if (!saved || last?.state !== "completed")
      fail("INVOCATION_RESULT_EXPIRED");
    const recovered: InvocationReceipt = {
      fingerprint: receipt.fingerprint,
      result: undefined!,
      continuations: new Map(),
    };
    this.restore(recovered, saved!);
    if (recovered.revision !== receipt.revision)
      fail("AUTHORIZATION_CHANGED");
    return this.replay(origin, params, receipt, recovered.result, signal);
  }

  private continue(
    origin: PluginInvocationOrigin,
    invocationId: string,
    params: PluginToolCallParams,
    receipt: InvocationReceipt,
    continuation: NonNullable<PluginInvocationPorts["continuation"]>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const submission = continuation.submission;
    if (
      !submission ||
      typeof submission.continuationId !== "string" ||
      !Number.isSafeInteger(submission.round) ||
      submission.round < 1 ||
      typeof submission.responsesBlobId !== "string" ||
      !submission.responsesBlobId.trim() ||
      submission.responsesBlobId.length > 512
    )
      return Promise.reject(new PluginInvocationError("INVALID_CONTINUATION"));
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(submission))
      .digest("hex");
    const prior = receipt.continuations.get(submission.round);
    if (prior)
      return prior.fingerprint === fingerprint
        ? this.replay(origin, params, receipt, prior.result, signal)
        : Promise.reject(
            new PluginInvocationError("CONTINUATION_INPUT_REUSED"),
          );
    const pending = receipt.pending;
    if (
      !pending ||
      pending.pending.continuationId !== submission.continuationId ||
      pending.pending.round !== submission.round
    )
      return Promise.reject(new PluginInvocationError("CONTINUATION_DENIED"));
    const previousResult = receipt.result;
    receipt.pending = undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    this.active.add(controller);
    let dispatched = false;
    const writerHash = randomBytes(32).toString("hex");
    let claimed = false;
    const result = Promise.resolve()
      .then(async () => {
        try {
          const authorization = await this.resolve(
            origin,
            sanitizePluginToolParams(params),
            controller.signal,
          );
          if (authorization.revision !== receipt.revision)
            fail("AUTHORIZATION_CHANGED");
          if (this.ports.receipts) {
            const claim = await awaitOwned(controller.signal, () =>
              this.ports.receipts!.claim(
                invocationId,
                {
                  fingerprint: receipt.fingerprint,
                  revision: authorization.revision,
                  writerHash,
                  round: submission.round,
                  legFingerprint: fingerprint,
                  continuationId: submission.continuationId,
                },
                controller.signal,
              ),
            );
            if (!claim.claimed) {
              this.restore(receipt, claim.receipt);
              const prior = receipt.continuations.get(submission.round);
              if (!prior) fail("CONTINUATION_RECEIPT_MISSING");
              return this.replay(
                origin,
                params,
                receipt,
                prior!.result,
                controller.signal,
              );
            }
            claimed = true;
            // Admission may have changed during the journal transaction.
            const current = await this.resolve(
              origin,
              sanitizePluginToolParams(params),
              controller.signal,
            );
            if (current.revision !== receipt.revision)
              fail("AUTHORIZATION_CHANGED");
            await this.ports.receipts.write(
              invocationId,
              { writerHash, round: submission.round, state: "dispatched" },
              controller.signal,
            );
            const currentAfterWrite = await this.resolve(
              origin,
              sanitizePluginToolParams(params),
              controller.signal,
            );
            if (currentAfterWrite.revision !== receipt.revision)
              fail("AUTHORIZATION_CHANGED");
          }
          this.observation(invocationId, "call-continued", origin);
          const output = await awaitOwned(controller.signal, () => {
            dispatched = true;
            return continuation.resume(
              authorization,
              sanitizePluginToolParams(params),
              controller.signal,
            );
          });
          const delivery = await this.resolve(
            origin,
            sanitizePluginToolParams(params),
            controller.signal,
          );
          if (delivery.revision !== receipt.revision)
            fail("AUTHORIZATION_CHANGED");
          if (output instanceof PluginInvocationSuspension) {
            if (
              output.pending.continuationId !== submission.continuationId ||
              output.pending.round !== submission.round + 1
            )
              fail("INVALID_INVOCATION_SUSPENSION");
            receipt.pending = output;
          }
          if (claimed)
            await this.persistResult(
              this.ports.receipts!,
              invocationId,
              writerHash,
              submission.round,
              output,
              controller.signal,
            );
          this.observation(
            invocationId,
            output instanceof PluginInvocationSuspension
              ? "call-suspended"
              : "call-completed",
            origin,
          );
          return output;
        } catch (error) {
          if (
            error instanceof PluginContinuationRefused &&
            !controller.signal.aborted &&
            !this.closed
          ) {
            if (claimed)
              await this.ports.receipts!.write(
                invocationId,
                { writerHash, round: submission.round, state: "refused" },
                controller.signal,
              );
            receipt.pending = pending;
            receipt.result = previousResult;
            receipt.continuations.delete(submission.round);
            throw error;
          }
          const terminal =
            error instanceof PluginContinuationTerminal &&
            !controller.signal.aborted &&
            !this.closed;
          this.observation(
            invocationId,
            dispatched && !terminal ? "call-unknown" : "call-denied",
            origin,
          );
          if (claimed)
            await this.persistFailure(
              invocationId,
              writerHash,
              submission.round,
              error,
              dispatched && !terminal,
              controller.signal,
            );
          if (dispatched && !terminal) fail("INVOCATION_OUTCOME_UNKNOWN", true);
          throw error;
        }
      })
      .finally(() => {
        this.active.delete(controller);
        signal?.removeEventListener("abort", abort);
      });
    receipt.result = result;
    receipt.continuations.set(submission.round, { fingerprint, result });
    return result;
  }

  close() {
    this.closed = true;
    for (const controller of this.active) controller.abort();
    for (const receipt of this.receipts.values()) this.budget.release(receipt);
  }

  /** Receipts prove an effect must not repeat; they never grant current access.
   * Each delivery owns its wait and fresh request ports. Aborting a duplicate
   * must not cancel the original effect or change its accepted receipt.
   */
  private async replay(
    origin: PluginInvocationOrigin,
    params: PluginToolCallParams,
    receipt: InvocationReceipt,
    result: Promise<unknown>,
    signal?: AbortSignal,
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    this.active.add(controller);
    try {
      const request = sanitizePluginToolParams(params);
      const before = await this.resolve(origin, request, controller.signal);
      if (receipt.revision && before.revision !== receipt.revision)
        fail("AUTHORIZATION_CHANGED");
      const settled = await awaitOwned(controller.signal, () => result).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const after = await this.resolve(origin, request, controller.signal);
      if (
        after.revision !== before.revision ||
        (receipt.revision && after.revision !== receipt.revision)
      )
        fail("AUTHORIZATION_CHANGED");
      if (!settled.ok) throw settled.error;
      return settled.value;
    } finally {
      this.active.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }

  private restore(receipt: InvocationReceipt, saved: DurableInvocationReceipt) {
    if (saved.fingerprint !== receipt.fingerprint) fail("INVOCATION_ID_REUSED");
    if (
      !saved.revision ||
      !Number.isSafeInteger(saved.expiresAt) ||
      saved.expiresAt <= Date.now() ||
      !Array.isArray(saved.legs) ||
      saved.legs.length < 1 ||
      saved.legs.length > INVOCATION_RECEIPT_MAX_ROUNDS + 1
    )
      fail("RECEIPT_STORE_INVALID");
    receipt.revision = saved.revision;
    receipt.pending = undefined;
    for (const [index, leg] of saved.legs.entries()) {
      if (leg.round !== index || !/^[0-9a-f]{64}$/.test(leg.fingerprint))
        fail("RECEIPT_STORE_INVALID");
      let result: Promise<unknown>;
      if (leg.state === "completed" || leg.state === "suspended") {
        if (
          typeof leg.valueJson !== "string" ||
          Buffer.byteLength(leg.valueJson) > INVOCATION_RECEIPT_VALUE_BYTES
        )
          fail("RECEIPT_STORE_INVALID");
        let value: unknown;
        try {
          value = JSON.parse(leg.valueJson!);
        } catch {
          fail("RECEIPT_STORE_INVALID");
        }
        if (leg.state === "suspended") {
          const pending =
            value && typeof value === "object" && !Array.isArray(value)
              ? (value as Record<string, unknown>)
              : undefined;
          if (
            !pending ||
            typeof leg.continuationId !== "string" ||
            pending.continuationId !== leg.continuationId ||
            pending.round !== leg.pendingRound ||
            leg.pendingRound !== leg.round + 1
          )
            fail("RECEIPT_STORE_INVALID");
          value = new PluginInvocationSuspension({
            ...pending!,
            continuationId: leg.continuationId!,
            round: leg.pendingRound!,
          });
        }
        result = Promise.resolve(value);
        if (
          index === saved.legs.length - 1 &&
          value instanceof PluginInvocationSuspension
        )
          receipt.pending = value;
      } else if (
        ["reserved", "dispatched", "failed", "unknown", "unavailable"].includes(
          leg.state,
        )
      ) {
        const unknown = leg.state !== "failed" && leg.state !== "unavailable";
        if (!unknown && !/^[A-Z0-9_]{1,96}$/.test(leg.errorCode ?? ""))
          fail("RECEIPT_STORE_INVALID");
        const code =
          !unknown && /^[A-Z0-9_]{1,96}$/.test(leg.errorCode ?? "")
            ? leg.errorCode!
            : "INVOCATION_OUTCOME_UNKNOWN";
        result = Promise.reject(new PluginInvocationError(code, unknown));
        void result.catch(() => {});
      } else fail("RECEIPT_STORE_INVALID");
      if (leg.round)
        receipt.continuations.set(leg.round, {
          fingerprint: leg.fingerprint,
          result: result!,
        });
      receipt.result = result!;
    }
  }

  /**
   * Record a known final result once the response is decided (`defer`),
   * retrying a transport failure a bounded number of times. Safe because the
   * leg is already `dispatched` before the call: until this write lands, and
   * forever if it never does, every reader of the receipt sees an uncertain
   * outcome (INVOCATION_OUTCOME_UNKNOWN) and never runs the call again. The
   * live request still answers with its result, and this process's own
   * replays read it from memory. Uses the request's receipt port as captured
   * now, never the request's signal: the response may already be gone.
   */
  private persistLater(
    defer: NonNullable<PluginInvocationPorts["defer"]>,
    id: string,
    writerHash: string,
    round: number,
    value: unknown,
  ) {
    const receipts = this.ports.receipts!;
    defer(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.persistResult(
            receipts,
            id,
            writerHash,
            round,
            value,
            AbortSignal.timeout(DEFERRED_RECEIPT_TIMEOUT_MS),
          );
          return;
        } catch (error) {
          if (
            attempt >= PLUGIN_DEFERRED_RECEIPT_ATTEMPTS ||
            !(error instanceof PluginInvocationError) ||
            error.code !== "RECEIPT_STORE_UNAVAILABLE"
          )
            return;
          await new Promise((done) =>
            setTimeout(done, DEFERRED_RECEIPT_RETRY_MS * attempt).unref?.(),
          );
        }
      }
    });
  }

  private async persistResult(
    receipts: PluginInvocationReceiptPort,
    id: string,
    writerHash: string,
    round: number,
    value: unknown,
    signal: AbortSignal,
  ) {
    const suspended = value instanceof PluginInvocationSuspension;
    const valueJson = JSON.stringify(suspended ? value.pending : value);
    if (
      typeof valueJson !== "string" ||
      Buffer.byteLength(valueJson) > INVOCATION_RECEIPT_VALUE_BYTES
    ) {
      await receipts.write(
        id,
        {
          writerHash,
          round,
          state: "unavailable",
          errorCode: "RECEIPT_VALUE_UNAVAILABLE",
        },
        signal,
      );
      return;
    }
    await receipts.write(
      id,
      {
        writerHash,
        round,
        state: suspended ? "suspended" : "completed",
        valueJson,
        ...(suspended
          ? {
              continuationId: value.pending.continuationId,
              pendingRound: value.pending.round,
            }
          : {}),
      },
      signal,
    );
  }

  private async persistFailure(
    id: string,
    writerHash: string,
    round: number,
    error: unknown,
    dispatched: boolean,
    signal: AbortSignal,
    known = false,
  ) {
    const code =
      error instanceof PluginInvocationError &&
      /^[A-Z0-9_]{1,96}$/.test(error.code)
        ? error.code
        : "INVOCATION_FAILED";
    if (!dispatched && round === 0) {
      // Proven pre-wire refusal: release the claim so a retry with this ID
      // starts over (and asks for approval again). A store that predates
      // retryable refusals rejects this; then record the final failure.
      try {
        await this.ports.receipts!.write(
          id,
          { writerHash, round, state: "refused" },
          signal,
        );
        return;
      } catch {
        /* Fall through to the final failure record. */
      }
    }
    try {
      await this.ports.receipts!.write(
        id,
        {
          writerHash,
          round,
          state: dispatched && !known ? "unknown" : "failed",
          errorCode: !dispatched
            ? code
            : known
              ? "TOOL_CALL_FAILED"
              : "INVOCATION_OUTCOME_UNKNOWN",
        },
        signal,
      );
    } catch {
      // A lost journal ACK never permits another wire attempt. The reservation
      // or dispatch intent remains uncertain until the original expiry.
    }
  }

  private observation(
    invocationId: string,
    kind: Parameters<NonNullable<AuthorizedToolInvoker["observe"]>>[1],
    origin: PluginInvocationOrigin,
  ) {
    // Evidence must never alter admission, an accepted effect, or its receipt.
    try {
      this.observe?.(invocationId, kind, origin);
    } catch {
      /* Recording is best effort; execution remains authoritative. */
    }
  }

  private async resolve(
    origin: PluginInvocationOrigin,
    params: PluginToolCallParams,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.closed) fail("INSTANCE_CLOSED");
    const authorization = structuredClone(
      await awaitOwned(signal, () =>
        this.ports.authorize(
          structuredClone(this.owner),
          origin,
          structuredClone(params),
          signal,
        ),
      ),
    );
    signal.throwIfAborted();
    if (
      this.closed ||
      !authorization.enabled ||
      !authorization.revision ||
      ownerKey(authorization.owner) !== ownerKey(this.owner)
    )
      fail("INVOCATION_DENIED");
    if (
      authorization.tool.name !== params.name ||
      !authorization.allowedOrigins.includes(origin)
    )
      fail("INVOCATION_DENIED");
    if (
      authorization.toolPolicy &&
      !decideToolPolicyFromSnapshot({
        snapshot: authorization.toolPolicy,
        toolName: params.name,
      }).allowed
    )
      fail("TOOL_POLICY_DENIED");
    const visibility = getToolVisibility(authorization.tool._meta);
    if (origin === "mention" && !isPluginMentionTool(authorization.tool))
      fail("TOOL_MENTION_DECLARATION_DENIED");
    if (
      (origin === "model" && !visibility.includes("model")) ||
      (origin === "app" && !visibility.includes("app"))
    )
      fail("TOOL_VISIBILITY_DENIED");
    return { ...authorization, origin };
  }

  private async run(
    origin: PluginInvocationOrigin,
    invocationId: string,
    params: PluginToolCallParams,
    signal: AbortSignal,
    receipt: InvocationReceipt,
  ) {
    let dispatched = false;
    const writerHash = randomBytes(32).toString("hex");
    let claimed = false;
    // The durable leg already says `dispatched` (claimed and marked in one
    // write), so no separate dispatch write follows.
    let marked = false;
    try {
      params = sanitizePluginToolParams(params);
      let authorization = await this.resolve(origin, params, signal);
      const revision = authorization.revision;
      receipt.revision = revision;
      if (this.ports.receipts) {
        // Claim and mark dispatched in ONE write when nothing gated runs
        // between them: no approval, no admission or metadata service. The
        // store still checks the instance is live in that same transaction,
        // and a fresh authorization still follows before the effect.
        const dispatch =
          !authorization.requiresApproval &&
          noAdmissionWork.has(this.ports.admit) &&
          !this.ports.metadata;
        const claim = await awaitOwned(signal, () =>
          this.ports.receipts!.claim(
            invocationId,
            {
              fingerprint: receipt.fingerprint,
              revision,
              writerHash,
              round: 0,
              legFingerprint: receipt.fingerprint,
              ...(dispatch ? { dispatch: true as const } : {}),
            },
            signal,
          ),
        );
        if (!claim.claimed) {
          this.restore(receipt, claim.receipt);
          return this.replay(origin, params, receipt, receipt.result, signal);
        }
        claimed = true;
        // The store's own answer says whether it marked the leg: an older
        // store refuses the combined claim, and the port falls back to a
        // plain one that leaves the leg reserved.
        marked =
          dispatch &&
          claim.receipt.legs.find((leg) => leg.round === 0)?.state ===
            "dispatched";
        authorization = await this.resolve(origin, params, signal);
        if (authorization.revision !== revision) fail("AUTHORIZATION_CHANGED");
      }
      if (authorization.requiresApproval) {
        if (
          !(await awaitOwned(signal, () =>
            this.ports.approve(
              authorization,
              invocationId,
              structuredClone(params),
              signal,
            ),
          ))
        )
          fail("APPROVAL_DENIED");
        authorization = await this.resolve(origin, params, signal);
        if (authorization.revision !== revision) fail("AUTHORIZATION_CHANGED");
      }
      if (!noAdmissionWork.has(this.ports.admit)) {
        await awaitOwned(signal, () =>
          this.ports.admit(authorization, invocationId, signal),
        );
        authorization = await this.resolve(origin, params, signal);
        if (authorization.revision !== revision) fail("AUTHORIZATION_CHANGED");
      }
      signal.throwIfAborted();
      const request = sanitizePluginToolParams(params);
      const metadata = this.ports.metadata;
      if (metadata) {
        const derived = await awaitOwned(signal, () =>
          metadata.call(
            this.ports,
            authorization,
            structuredClone(params),
            signal,
          ),
        );
        if (Object.keys(derived).length > 0)
          request._meta = { ...request._meta, ...structuredClone(derived) };
        // A real metadata service can wait even when it returns no fields.
        // Revalidate after that await before dispatch; admission and receipt
        // writes keep their own fences when there is no metadata service.
        authorization = await this.resolve(origin, params, signal);
        if (authorization.revision !== revision) fail("AUTHORIZATION_CHANGED");
      }
      if (claimed && !marked) {
        await this.ports.receipts!.write(
          invocationId,
          { writerHash, round: 0, state: "dispatched" },
          signal,
        );
        authorization = await this.resolve(origin, params, signal);
        if (authorization.revision !== revision) fail("AUTHORIZATION_CHANGED");
      }
      const result = await awaitOwned(signal, () => {
        dispatched = true;
        return this.ports.execute(authorization, request, signal, invocationId);
      });
      const completed = await this.resolve(origin, params, signal);
      if (completed.revision !== revision) fail("AUTHORIZATION_CHANGED");
      if (result instanceof PluginInvocationSuspension)
        receipt.pending = result;
      if (claimed) {
        // A suspension's record is what its continuation reads next, so it
        // is written before the response; a known final result's record is
        // not needed to answer this request.
        const defer =
          result instanceof PluginInvocationSuspension
            ? undefined
            : this.ports.defer;
        if (defer)
          this.persistLater(defer, invocationId, writerHash, 0, result);
        else
          await this.persistResult(
            this.ports.receipts!,
            invocationId,
            writerHash,
            0,
            result,
            signal,
          );
      }
      return result;
    } catch (error) {
      // A cancelled/revoked owner cannot deliver a result or safely retry a
      // write. Only an authoritative server failure is a known outcome.
      let known = false;
      if (
        dispatched &&
        !signal.aborted &&
        !this.closed &&
        !(error instanceof PluginInvocationError)
      )
        try {
          known = this.ports.classifyFailure(error) === "failed";
        } catch {
          /* Fail uncertain. */
        }
      if (claimed)
        await this.persistFailure(
          invocationId,
          writerHash,
          0,
          error,
          dispatched,
          signal,
          known,
        );
      if (!dispatched) {
        receipt.retryable = true;
        throw error;
      }
      if (!known) fail("INVOCATION_OUTCOME_UNKNOWN", true);
      throw error;
    }
  }
}
