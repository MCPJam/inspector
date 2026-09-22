/**
 * `mrtr-driver.ts` — MCPJam's manual driver for the MCP 2026-07-28
 * **multi-round-trip / `input_required`** interaction (spec §12; upstream
 * `InputRequiredResult`). A modern `tools/call`, `prompts/get`, or
 * `resources/read` may answer with an `input_required` result carrying embedded
 * elicitation requests plus an opaque `requestState`; the client collects the
 * input and **retries the original operation** with the responses + the echoed
 * state, possibly for several rounds, until a complete result comes back.
 *
 * ## Why a serializable stepper (not just an async loop)
 *
 * Hosted MCPJam is horizontally scaled: a modern `input_required` can arrive
 * mid-tool-execution while a worker holds an SSE stream open, and §12.5.2
 * forbids blocking a worker while a human thinks. The loop is therefore split
 * into a **pure data state** ({@link MrtrOperationState}) and pure step
 * functions ({@link executeInputRequiredLeg} / {@link
 * resumeInputRequiredOperation}). A local/CLI surface layers the convenience
 * {@link runInputRequiredOperation} loop over the stepper; a hosted surface
 * (PR3+) persists the state to Convex between rounds and resumes on a fresh
 * worker. **The state never holds a `Client`, promise, closure, resolver, or
 * `AbortSignal`** — only JSON-serializable data.
 *
 * ## What the driver owns
 *
 * - **The round cap.** The upstream SDK's automatic driver (`maxRounds`,
 *   `InputRequiredRoundsExceeded`) applies to `autoFulfill: true` only. MCPJam
 *   runs manual mode (`autoFulfill: false`), so the cap is owned here: it is
 *   {@link DEFAULT_MAX_MRTR_ROUNDS} by default, persisted in the state so a
 *   hosted resume keeps counting, and exceeding it raises the *same typed
 *   upstream shape* — `new SdkError(SdkErrorCode.InputRequiredRoundsExceeded,
 *   …, { rounds })` — so existing guards work.
 * - **Per-round response replacement.** Each retry carries `inputResponses`
 *   for *that round only* (never accumulated across rounds) and echoes
 *   `requestState` byte-exact when present, omitting it when absent.
 * - **Undeclared-request rejection (Decision 8).** 2026 clients silently drop
 *   inbound server→client requests, so an embedded `roots/list` /
 *   `sampling/createMessage` (which this client never advertises) — or an
 *   undeclared elicitation mode — is detected *here, on the result*, before any
 *   UI is shown, and rejected with precise evidence.
 * - **Strict self-validation (§12.1.11).** `acceptedContent` is not exported by
 *   the client package, so collected elicitation content is validated against
 *   the request's `requestedSchema` before it is sent. The JSON-Schema engine
 *   is *injected* (see {@link ElicitationContentValidator}) so this module
 *   stays browser-safe; callers wire a **strict** dialect-aware validator whose
 *   unknown-dialect behavior rejects rather than fails open.
 *
 * `requestState` is opaque: it is echoed verbatim and never parsed, normalized,
 * or logged (redact if traced).
 */

import {
  isInputRequiredResult,
  withInputRequired,
  SdkError as UpstreamSdkError,
  SdkErrorCode,
  type InputRequiredResult,
  type InputRequests,
  type InputResponses,
  type InputResponse,
  type Request,
  type RequestOptions,
  type StandardSchemaV1,
} from "@modelcontextprotocol/client";

import type { ManagedMcpClient } from "./managed-mcp-client.js";

// Re-export the upstream primitives through the sdk so consumers do not need a
// direct dependency on `@modelcontextprotocol/client` for the common path.
export {
  isInputRequiredResult,
  withInputRequired,
  type InputRequiredResult,
  type InputRequests,
  type InputResponses,
} from "@modelcontextprotocol/client";

/** The three verbs that can enter a multi-round-trip loop (spec §12.1). */
export type MrtrMethod = "tools/call" | "prompts/get" | "resources/read";

/** Elicitation delivery modes this client understands. */
export type ElicitationMode = "form" | "url";

/** Default modes accepted when validating embedded `elicitation/create`. */
export const SUPPORTED_ELICITATION_MODES: readonly ElicitationMode[] = [
  "form",
  "url",
];

/**
 * The elicitation modes an MRTR round may embed. A thunk defers the lookup to
 * leg time, which is what a caller deriving the set from the negotiated
 * `elicitation` capability needs: that capability is only known once the
 * connection has initialized, which happens inside the first leg.
 */
export type MrtrSupportedModes =
  | readonly ElicitationMode[]
  | (() => readonly ElicitationMode[]);

/**
 * MCPJam owns the round cap in manual mode; this mirrors the upstream
 * automatic driver's `maxRounds` default so behavior is consistent across
 * modes.
 */
export const DEFAULT_MAX_MRTR_ROUNDS = 10;

/**
 * The complete, JSON-serializable state of one in-flight MRTR operation.
 *
 * DATA ONLY — never a `Client`, promise, closure, resolver, or `AbortSignal`.
 * A hosted surface persists this between rounds and rehydrates it on resume.
 */
export interface MrtrOperationState {
  /** Stable id for this logical operation across all its rounds. */
  readonly opId: string;
  /** The entry verb; drives request construction on every retry. */
  readonly method: MrtrMethod;
  /**
   * The immutable original application params (e.g. `{ name, arguments }` for
   * a tool). Preserved byte-for-byte across every round; retries spread
   * `inputResponses` / `requestState` on top without mutating this.
   */
  readonly originalParams: Record<string, unknown>;
  /**
   * Number of retry legs performed so far. `0` before the initial send.
   * Persisted so a hosted resume keeps counting toward {@link maxRounds}.
   */
  readonly round: number;
  /** MCPJam-owned round cap, persisted so resumes continue enforcing it. */
  readonly maxRounds: number;
  /**
   * The opaque server state to echo verbatim on the next retry, present only
   * when the last `input_required` carried one. Never parsed, normalized, or
   * logged.
   */
  readonly requestState?: string;
  /**
   * The current round's embedded requests awaiting responses, keyed by the
   * server's (untrusted) keys. Empty for a state-only round or before the
   * first `input_required`. Kept as data (includes each request's
   * `requestedSchema`) so a hosted resume can self-validate collected content.
   */
  readonly pendingInputRequests: InputRequests;
}

/** Result of stepping one MRTR leg. */
export type MrtrLegResult<TResult> =
  | { readonly status: "complete"; readonly result: TResult }
  | { readonly status: "input_required"; readonly state: MrtrOperationState };

/**
 * Sends exactly one wire leg. The driver builds the `{ method, params }`
 * request (original params + this round's `inputResponses` + echoed
 * `requestState`); the sender performs the wire call and returns the raw
 * result — either a complete result of the entry verb or an
 * {@link InputRequiredResult}. Implementations preserve Phase-3 helper
 * semantics (output-schema validation, `Mcp-Param-*` mirroring, response
 * cache) and their own retry/timeout wrappers; the driver is the inner leaf.
 */
export type MrtrLegSender<TResult = unknown> = (
  request: { readonly method: MrtrMethod; readonly params: Record<string, unknown> },
  ctx: { readonly round: number; readonly signal?: AbortSignal }
) => Promise<TResult | InputRequiredResult>;

/**
 * Validates collected elicitation content against the request's
 * `requestedSchema` (§12.1.11). Injected so the browser-hostile Ajv engine is
 * never pulled into this module's import graph; callers wire a **strict**
 * dialect-aware validator (unknown dialect → invalid, not fail-open).
 */
export type ElicitationContentValidator = (
  requestedSchema: unknown,
  content: unknown
) => { valid: boolean; error?: string };

/** Collects responses for one round's embedded requests. */
export type MrtrInputCollector = (request: {
  readonly state: MrtrOperationState;
  readonly inputRequests: InputRequests;
  readonly signal?: AbortSignal;
}) => Promise<InputResponses>;

/** Validates the final complete result (e.g. tool output-schema check). */
export type MrtrValidateResponse<TResult> = (
  result: TResult
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Errors + guards
// ---------------------------------------------------------------------------

/**
 * The server embedded a request this client never advertised (`roots/list` /
 * `sampling/createMessage`) or an otherwise unsupported input method. Detected
 * at the result (Decision 8: modern clients silently drop inbound requests, so
 * a `setRequestHandler` would never fire) and rejected before any UI.
 */
export class MrtrUndeclaredInputError extends Error {
  readonly code = "MRTR_UNDECLARED_INPUT";
  constructor(
    readonly method: string,
    readonly inputKey: string,
    message: string
  ) {
    super(message);
    this.name = "MrtrUndeclaredInputError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The server requested an elicitation mode this client does not support. */
export class MrtrUnsupportedElicitationModeError extends Error {
  readonly code = "MRTR_UNSUPPORTED_ELICITATION_MODE";
  constructor(
    readonly mode: string,
    readonly inputKey: string,
    /**
     * The modes actually allowed for this connection. Defaults to everything
     * this client can render; a caller that declared a narrower `elicitation`
     * capability passes its own set so the message names what was declared.
     */
    readonly supportedModes: readonly ElicitationMode[] = SUPPORTED_ELICITATION_MODES
  ) {
    super(
      `Embedded elicitation request "${inputKey}" declared unsupported mode "${mode}" ` +
        `(supported: ${supportedModes.join(", ")}).`
    );
    this.name = "MrtrUnsupportedElicitationModeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A collected response failed local self-validation: a missing/extra key for
 * the round, or accepted elicitation content that does not satisfy the
 * request's `requestedSchema`.
 */
export class MrtrInputValidationError extends Error {
  readonly code = "MRTR_INPUT_VALIDATION";
  constructor(message: string) {
    super(message);
    this.name = "MrtrInputValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** `true` iff `err` is the upstream typed round-cap-exceeded error. */
export function isMaxRoundsExceeded(err: unknown): boolean {
  return (
    UpstreamSdkError.isInstance(err) &&
    (err as UpstreamSdkError).code === SdkErrorCode.InputRequiredRoundsExceeded
  );
}

/**
 * `true` iff `err` is the upstream typed "unsupported result type" error —
 * raised by the SDK when a modern non-complete result surfaces on a call that
 * did not opt in with `allowInputRequired`.
 */
export function isUnsupportedResultType(err: unknown): boolean {
  return (
    UpstreamSdkError.isInstance(err) &&
    (err as UpstreamSdkError).code === SdkErrorCode.UnsupportedResultType
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Copies an `InputRequests` / `InputResponses` map onto a **null-prototype**
 * object. Server-assigned keys are untrusted, so we never let a `__proto__` /
 * `constructor` key reach a normal object's prototype chain.
 */
function toSafeMap<T>(src: Record<string, T> | undefined): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (src) {
    for (const key of Object.keys(src)) {
      out[key] = src[key];
    }
  }
  return out;
}

/**
 * A permissive Standard-Schema for the complete branch. The upstream request
 * funnel routes an `input_required` result through its non-complete handler
 * *before* result-schema validation, so this schema only ever sees a genuine
 * complete result; MCPJam re-imposes verb-specific validation (e.g. tool
 * output-schema) separately. Kept permissive because the upstream typed
 * `*ResultSchema`s are not exported from the client package.
 */
const passthroughResultSchema: StandardSchemaV1<unknown, Record<string, unknown>> =
  {
    "~standard": {
      version: 1,
      vendor: "mcpjam-mrtr",
      validate: (value) => ({ value: (value ?? {}) as Record<string, unknown> }),
    },
  };

/** The default result schema for a verb's complete result. */
export function defaultResultSchemaForMethod(
  _method: MrtrMethod
): StandardSchemaV1<unknown, Record<string, unknown>> {
  return passthroughResultSchema;
}

/**
 * The default leg sender: the type-correct explicit-schema path
 * (`requestWithSchema(req, withInputRequired(resultSchema), { allowInputRequired })`).
 * This is the only path that correctly surfaces an `input_required` result on
 * *every* round — the higher-level `callTool` helper asserts a complete result
 * and would throw on an intermediate `input_required` leg for a tool that
 * declares an `outputSchema`.
 */
export function makeRequestWithSchemaLegSender<TResult = unknown>(
  client: Pick<ManagedMcpClient, "requestWithSchema">,
  resultSchema: StandardSchemaV1 = passthroughResultSchema,
  baseOptions?: RequestOptions
): MrtrLegSender<TResult> {
  const wrapped = withInputRequired(resultSchema);
  return (request, ctx) =>
    client.requestWithSchema(
      request as Request,
      wrapped,
      {
        ...baseOptions,
        allowInputRequired: true,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }
    ) as Promise<TResult | InputRequiredResult>;
}

/** Builds the retry params for one leg: original params + this-round-only responses + echoed state. */
function buildRetryParams(
  state: MrtrOperationState,
  currentRoundResponses?: InputResponses
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...state.originalParams };
  if (currentRoundResponses && Object.keys(currentRoundResponses).length > 0) {
    // This round only — responses are replaced, never accumulated.
    params.inputResponses = currentRoundResponses;
  }
  if (state.requestState !== undefined) {
    // Echo verbatim; opaque.
    params.requestState = state.requestState;
  }
  return params;
}

/**
 * Validates the *entire* embedded-requests map before any of it is surfaced to
 * a UI (§12.3): rejects undeclared `roots/list` / `sampling/createMessage`
 * (Decision 8), unknown methods, and unsupported elicitation modes.
 */
export function validateInputRequests(
  inputRequests: InputRequests,
  supportedModes: readonly ElicitationMode[] = SUPPORTED_ELICITATION_MODES
): void {
  for (const key of Object.keys(inputRequests)) {
    const req = inputRequests[key] as { method?: string; params?: Record<string, unknown> };
    const method = req?.method;
    if (method === "roots/list" || method === "sampling/createMessage") {
      throw new MrtrUndeclaredInputError(
        method,
        key,
        `Server embedded an undeclared "${method}" request under key "${key}"; ` +
          `this client advertises neither roots nor sampling, so it cannot fulfil it.`
      );
    }
    if (method === "elicitation/create") {
      const mode = (req.params?.mode as string | undefined) ?? "form";
      if (!supportedModes.includes(mode as ElicitationMode)) {
        throw new MrtrUnsupportedElicitationModeError(mode, key, supportedModes);
      }
      continue;
    }
    throw new MrtrUndeclaredInputError(
      String(method),
      key,
      `Server embedded an unsupported input request method "${String(method)}" under key "${key}".`
    );
  }
}

/**
 * Validates a round's collected responses against its pending requests: every
 * pending key answered, no unexpected keys, and every *accepted* form
 * elicitation's content self-validated against its `requestedSchema`.
 */
export function validateRoundResponses(
  state: MrtrOperationState,
  responses: InputResponses,
  validateContent?: ElicitationContentValidator
): void {
  const pending = state.pendingInputRequests;
  const pendingKeys = Object.keys(pending);
  for (const key of pendingKeys) {
    // Own-property check: an untrusted server key such as `toString` /
    // `constructor` must count as missing unless the collector actually
    // returned it, so a hostile key can't slip through via the prototype chain.
    if (!Object.prototype.hasOwnProperty.call(responses, key)) {
      throw new MrtrInputValidationError(
        `Missing response for embedded input "${key}".`
      );
    }
  }
  for (const key of Object.keys(responses)) {
    if (!pendingKeys.includes(key)) {
      throw new MrtrInputValidationError(
        `Unexpected response key "${key}" not requested this round.`
      );
    }
  }
  for (const key of pendingKeys) {
    const req = pending[key] as { method?: string; params?: Record<string, unknown> };
    const res = responses[key] as InputResponse & { action?: string; content?: unknown };
    if (req?.method !== "elicitation/create") {
      continue;
    }
    // Decline / cancel are RESPONSES, not errors — no content to validate.
    if (res?.action !== "accept") {
      continue;
    }
    const requestedSchema = req.params?.requestedSchema;
    // URL-mode consent carries no content schema.
    if (requestedSchema === undefined || validateContent === undefined) {
      continue;
    }
    const result = validateContent(requestedSchema, (res.content ?? {}) as unknown);
    if (!result.valid) {
      throw new MrtrInputValidationError(
        `Accepted elicitation content for "${key}" failed schema validation: ${
          result.error ?? "invalid"
        }`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

/** Creates the initial state for a fresh operation (round 0, no pending input). */
export function initInputRequiredState(args: {
  opId?: string;
  method: MrtrMethod;
  params: Record<string, unknown>;
  maxRounds?: number;
}): MrtrOperationState {
  return {
    opId: args.opId ?? `mrtr_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
    method: args.method,
    originalParams: { ...args.params },
    round: 0,
    maxRounds: args.maxRounds ?? DEFAULT_MAX_MRTR_ROUNDS,
    pendingInputRequests: toSafeMap(undefined),
  };
}

/**
 * Steps exactly one MRTR leg: sends the wire request for `state` carrying
 * `currentRoundResponses` (validated first), then classifies the result.
 *
 * - complete result → `{ status: 'complete', result }`.
 * - `input_required` → validates the entire embedded map (undeclared / mode),
 *   enforces the MCPJam round cap, and returns `{ status: 'input_required',
 *   state }` with the next round's pending requests and echoed `requestState`.
 *
 * Abort: `signal` is threaded to the sender (wire-active window). Aborting the
 * local-pending window (input collection) is the caller's concern. On abort the
 * caller's `AbortError` propagates — it is never converted to a decline.
 */
export async function executeInputRequiredLeg<TResult = unknown>(args: {
  sender: MrtrLegSender<TResult>;
  state: MrtrOperationState;
  currentRoundResponses?: InputResponses;
  signal?: AbortSignal;
  validateContent?: ElicitationContentValidator;
  supportedElicitationModes?: MrtrSupportedModes;
}): Promise<MrtrLegResult<TResult>> {
  const {
    sender,
    state,
    currentRoundResponses,
    signal,
    validateContent,
    supportedElicitationModes = SUPPORTED_ELICITATION_MODES,
  } = args;

  // Validate this round's responses before they leave the process.
  if (currentRoundResponses !== undefined) {
    validateRoundResponses(state, currentRoundResponses, validateContent);
  } else if (Object.keys(state.pendingInputRequests).length > 0) {
    throw new MrtrInputValidationError(
      "This round has pending input requests but no responses were supplied."
    );
  }

  const safeResponses =
    currentRoundResponses !== undefined
      ? toSafeMap<InputResponse>(currentRoundResponses)
      : undefined;
  const params = buildRetryParams(state, safeResponses);

  const raw = await sender({ method: state.method, params }, { round: state.round, signal });

  if (!isInputRequiredResult(raw)) {
    return { status: "complete", result: raw as TResult };
  }

  const nextRound = state.round + 1;
  if (nextRound > state.maxRounds) {
    throw new UpstreamSdkError(
      SdkErrorCode.InputRequiredRoundsExceeded,
      `MCP multi-round-trip exceeded MCPJam's round cap of ${state.maxRounds} for ${state.method}.`,
      {
        rounds: state.maxRounds,
        lastResult: {
          // `requestState` is opaque and must never be logged (see module
          // header); an upstream error reporter would serialize it out of
          // `data`. The round count + request keys are enough for diagnostics.
          inputRequests: raw.inputRequests,
        },
      }
    );
  }

  const inputRequests = toSafeMap<InputRequests[string]>(raw.inputRequests);
  // Resolved HERE, after the leg returned — not when the operation was built.
  // The declared `elicitation` capability is only on record once `initialize`
  // has run, and it is this first leg that establishes the connection.
  const resolvedModes =
    typeof supportedElicitationModes === "function"
      ? supportedElicitationModes()
      : supportedElicitationModes;
  // Validate the ENTIRE map before returning (no UI is shown for a bad round).
  validateInputRequests(inputRequests, resolvedModes);

  const nextState: MrtrOperationState = {
    opId: state.opId,
    method: state.method,
    originalParams: state.originalParams,
    round: nextRound,
    maxRounds: state.maxRounds,
    ...(raw.requestState !== undefined ? { requestState: raw.requestState } : {}),
    pendingInputRequests: inputRequests,
  };
  return { status: "input_required", state: nextState };
}

/**
 * Resumes a suspended operation: submits `responses` for the state's current
 * pending requests and runs one retry leg. Rebuilds the default
 * `requestWithSchema` sender from `client` unless a verb-specific `sender` is
 * supplied (the manager passes one to preserve Phase-3 helper semantics).
 */
export function resumeInputRequiredOperation<TResult = unknown>(
  client: Pick<ManagedMcpClient, "requestWithSchema">,
  state: MrtrOperationState,
  responses: InputResponses,
  config?: {
    sender?: MrtrLegSender<TResult>;
    resultSchema?: StandardSchemaV1;
    requestOptions?: RequestOptions;
    signal?: AbortSignal;
    validateContent?: ElicitationContentValidator;
    supportedElicitationModes?: MrtrSupportedModes;
  }
): Promise<MrtrLegResult<TResult>> {
  const sender =
    config?.sender ??
    makeRequestWithSchemaLegSender<TResult>(
      client,
      config?.resultSchema ?? defaultResultSchemaForMethod(state.method),
      config?.requestOptions
    );
  return executeInputRequiredLeg<TResult>({
    sender,
    state,
    currentRoundResponses: responses,
    signal: config?.signal,
    validateContent: config?.validateContent,
    supportedElicitationModes: config?.supportedElicitationModes,
  });
}

// ---------------------------------------------------------------------------
// Convenience loop (local / CLI surfaces)
// ---------------------------------------------------------------------------

export interface RunInputRequiredOptions<TResult = unknown> {
  /**
   * Client for the default `requestWithSchema` sender. Optional: omit it when
   * a verb-specific {@link sender} is supplied (the manager does this to
   * preserve Phase-3 helper semantics). Required otherwise.
   */
  client?: Pick<ManagedMcpClient, "requestWithSchema">;
  method: MrtrMethod;
  params: Record<string, unknown>;
  /** Collects responses for each round's embedded requests. */
  collectInput: MrtrInputCollector;
  /** Verb-specific sender; defaults to the `requestWithSchema` path. */
  sender?: MrtrLegSender<TResult>;
  /** Result schema for the complete branch of the default sender. */
  resultSchema?: StandardSchemaV1;
  /** Base request options threaded into every leg (timeout, cacheMode, …). */
  requestOptions?: RequestOptions;
  /** Runs on the final complete result (e.g. tool output-schema validation). */
  validateResponse?: MrtrValidateResponse<TResult>;
  /** Strict content validator for accepted elicitation input. */
  validateContent?: ElicitationContentValidator;
  supportedElicitationModes?: MrtrSupportedModes;
  /** MCPJam-owned round cap; defaults to {@link DEFAULT_MAX_MRTR_ROUNDS}. */
  maxRounds?: number;
  /** Abort signal for both the wire-active and local-pending windows. */
  signal?: AbortSignal;
  opId?: string;
}

/**
 * Runs an MRTR operation to completion over the stepper: initial send, then a
 * collect→retry loop per round until a complete result. Suitable for local and
 * CLI surfaces; hosted surfaces persist {@link MrtrOperationState} between
 * rounds instead of looping in-process.
 *
 * The wire legs and the human-input collection are separate windows: a
 * transient wire failure is the sender's concern (which owns retry) and never
 * restarts the loop at round zero, because the loop's state lives here — outside
 * the sender.
 */
export async function runInputRequiredOperation<TResult = unknown>(
  options: RunInputRequiredOptions<TResult>
): Promise<TResult> {
  let sender = options.sender;
  if (sender === undefined) {
    if (options.client === undefined) {
      throw new Error(
        "runInputRequiredOperation requires either a `sender` or a `client`."
      );
    }
    sender = makeRequestWithSchemaLegSender<TResult>(
      options.client,
      options.resultSchema ?? defaultResultSchemaForMethod(options.method),
      options.requestOptions
    );
  }

  let state = initInputRequiredState({
    opId: options.opId,
    method: options.method,
    params: options.params,
    maxRounds: options.maxRounds,
  });

  let leg = await executeInputRequiredLeg<TResult>({
    sender,
    state,
    signal: options.signal,
    supportedElicitationModes: options.supportedElicitationModes,
  });

  while (leg.status === "input_required") {
    state = leg.state;
    // A state-only round (no embedded requests) is an immediate retry — there
    // is nothing to collect, so the collector is not invoked.
    const hasPending = Object.keys(state.pendingInputRequests).length > 0;
    // Local-pending window: an abort here rejects `collectInput`; the resulting
    // AbortError propagates (never converted to a decline).
    const responses = hasPending
      ? await options.collectInput({
          state,
          inputRequests: state.pendingInputRequests,
          signal: options.signal,
        })
      : {};
    leg = await executeInputRequiredLeg<TResult>({
      sender,
      state,
      currentRoundResponses: responses,
      signal: options.signal,
      validateContent: options.validateContent,
      supportedElicitationModes: options.supportedElicitationModes,
    });
  }

  if (options.validateResponse) {
    await options.validateResponse(leg.result);
  }
  return leg.result;
}
