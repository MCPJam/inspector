/**
 * The publisher-neutral readiness runner.
 *
 * ONE implementation for both publishers and both execution modes. A local
 * `/api/mcp/…` request and a hosted durable run reach the same four steps in
 * the same order — gather pinned evidence, optionally ask the backend broker
 * for model observations, validate and map them, grade — and differ only in
 * what they do with the result. Forking it per surface is how a hosted run and
 * a local run of the same server end up disagreeing, and the first question
 * anyone asks about a disagreement is which one to believe.
 *
 * WHAT THIS FILE DOES NOT DO, structurally rather than by discipline:
 *
 *   - it never calls a model. Observations come from the backend broker, which
 *     owns the credentials, the model choice and the spending. This module
 *     sends evidence and receives a validated envelope or a reason.
 *   - it never recomputes a finding. The SDK grades; this orchestrates. An
 *     adapter that re-derived a verdict would be a second opinion about a
 *     settled question.
 *   - it never dials with an unguarded transport. `fetchFn` is required, and
 *     in hosted mode it is the DNS-pinned one — resolve once, refuse the
 *     disallowed answers, pin the surviving addresses into the socket.
 */

import {
  gatherClaudeReadinessEvidence,
  gatherOpenAIReadinessEvidence,
  DIRECTORY_OBSERVATION_REASONS,
  gradeClaudeReadiness,
  gradeOpenAIReadiness,
  parseClaudeExperienceObservations,
  parseOpenAIExperienceObservations,
  type ClaudeReadinessResult,
  type DirectoryObservationEnvelope,
  type DirectoryObservationReason,
  type DirectoryObservationState,
  type OpenAIReadinessResult,
  type OpenAISubmissionMode,
} from "@mcpjam/sdk";

export type ReadinessPublisher = "claude" | "openai";

/** The result either publisher produces, discriminated by `readinessKind`. */
export type DirectoryReadinessResult =
  | ClaudeReadinessResult
  | OpenAIReadinessResult;

/**
 * How this run asks for model observations, when it asks at all.
 *
 * A CALLBACK rather than a client, so the runner has no idea whether the
 * answer came from a backend broker, a fixture or a replay — and so a local
 * run, which has no lease and no payer, simply does not pass one. The absence
 * is the guarantee: a runner with no requester cannot spend.
 */
export type ObservationRequester = (input: {
  publisher: ReadinessPublisher;
  /** Bounded, already-redacted evidence for the model to read. */
  evidence: string;
}) => Promise<ObservationBrokerAnswer>;

/** What the broker answers with, mirrored from the backend's own shape. */
export interface ObservationBrokerAnswer {
  status:
    | "completed"
    | "billing-blocked"
    | "provider-failed"
    | "invalid-output";
  reason?: string;
  detail?: string;
  /** Raw, and deliberately so — this module validates it before use. */
  envelope?: unknown;
}

export interface RunReadinessOptions {
  publisher: ReadinessPublisher;
  /** The target URL exactly as it was saved or entered. Never canonicalized. */
  target: string;
  /** REQUIRED. In hosted mode this is the DNS-pinned transport. */
  fetchFn: typeof fetch;
  /** The DECLARED submission shape. Required for OpenAI, absent for Claude. */
  submissionMode?: OpenAISubmissionMode;
  /** Headers the target needs, e.g. a saved server's credential. */
  headers?: Record<string, string>;
  /** Cancellation. A cancelled run must stop dialling somebody else's server. */
  signal?: AbortSignal;
  /** Absent ⇒ this run cannot request observations and cannot spend. */
  requestObservations?: ObservationRequester;
  /** Per-request budget. The caller owns the run-level deadline. */
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * The two "stop this run" signals, defined HERE rather than where they are
 * thrown.
 *
 * Both mean the same thing to the runner and to every caller of it: this
 * execution has no business continuing, and no business writing a result. They
 * live beside the runner because the runner is what has to let them through —
 * every OTHER failure in an observation call becomes a gap, and if these two
 * were ordinary errors they would be swallowed into a gap too. A run whose
 * lease was reassigned would then dial on, grade, and try to finalize over the
 * verdict that replaced it.
 */
export class ReadinessRunCancelledError extends Error {
  readonly code = "readinessRunCancelled" as const;
  constructor() {
    super("The readiness run was cancelled.");
  }
}

export class ReadinessLeaseLostError extends Error {
  readonly code = "readinessLeaseLost" as const;
  constructor() {
    super("This node no longer holds the readiness run's lease.");
  }
}

/** Whether a thrown value is one of the two stop signals. */
function isStopSignal(error: unknown): boolean {
  return (
    error instanceof ReadinessRunCancelledError ||
    error instanceof ReadinessLeaseLostError
  );
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ReadinessRunCancelledError();
}

/**
 * Bound on the evidence handed to the broker.
 *
 * Matches the backend's own ceiling. Enforced HERE as well as there, because
 * the honest failure for oversized evidence is a smaller prompt rather than a
 * 413 that loses the whole observation pass — and because a worker that
 * discovers its own limit does not need a round trip to learn it.
 */
const MAX_OBSERVATION_EVIDENCE_BYTES = 256 * 1024;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function summarizeTool(tool: unknown): string | undefined {
  const record = asRecord(tool);
  const name = typeof record?.name === "string" ? record.name : undefined;
  if (!name) return undefined;
  const description =
    typeof record?.description === "string" ? record.description : "";
  const annotations = asRecord(record?.annotations);
  const hints = annotations
    ? Object.entries(annotations)
        .filter(([, value]) => typeof value === "boolean")
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
    : "";
  return `- ${name}${hints ? ` [${hints}]` : ""}: ${description.slice(0, 400)}`;
}

/**
 * Render the evidence the model reads, as text.
 *
 * TEXT RATHER THAN THE EVIDENCE OBJECT, and not for the model's convenience.
 * The evidence object carries raw headers, redirect chains and metadata
 * documents — a server's `WWW-Authenticate` challenge and its PRM document are
 * in there, and neither belongs in a provider prompt. Rendering a deliberate
 * subset is what makes "we did not send that" a property of the code rather
 * than a claim.
 *
 * What is included is what the observation catalogue is actually ABOUT: tool
 * names, descriptions and annotation hints, and skill names and descriptions.
 * Nothing else, and nothing the deterministic checks already grade.
 */
export function renderObservationEvidence(input: {
  target: string;
  tools?: readonly unknown[];
  skills?: readonly { name?: string; description?: string }[];
}): string {
  const lines: string[] = [];
  let origin = input.target;
  try {
    origin = new URL(input.target).origin;
  } catch {
    // An unparseable target is reported as entered. Better an odd-looking
    // line than a thrown gatherer over a cosmetic field.
  }
  lines.push(`Server: ${origin}`);

  const tools = (input.tools ?? [])
    .map(summarizeTool)
    .filter((line): line is string => line !== undefined);
  lines.push("", `Tools (${tools.length}):`);
  lines.push(...(tools.length > 0 ? tools : ["(none advertised)"]));

  // FILTERED BEFORE IT IS COUNTED, like the tools above. A header promising
  // three skills over two rendered lines invites the model to reason about one
  // it was never shown.
  const skills = (input.skills ?? []).filter(
    (skill): skill is { name: string; description?: string } =>
      typeof skill.name === "string" && skill.name.length > 0,
  );
  if (skills.length > 0) {
    lines.push("", `Skills (${skills.length}):`);
    for (const skill of skills) {
      lines.push(`- ${skill.name}: ${(skill.description ?? "").slice(0, 400)}`);
    }
  }

  const rendered = lines.join("\n");
  const encoded = new TextEncoder().encode(rendered);
  if (encoded.byteLength <= MAX_OBSERVATION_EVIDENCE_BYTES) return rendered;
  // TRUNCATED WITH A MARKER. The model is told its view is partial so it does
  // not report "only three tools" about a server with three hundred, and the
  // marker is what stops a silently-shortened prompt from reading as the whole
  // surface.
  return `${new TextDecoder().decode(
    encoded.slice(0, MAX_OBSERVATION_EVIDENCE_BYTES - 200),
  )}\n\n[evidence truncated at the prompt size limit; this is a partial view]`;
}

/**
 * Ask for observations, and turn every possible answer into a state.
 *
 * TOTAL. Every failure path here — the broker refused, the transport died, the
 * envelope did not validate — becomes a `DirectoryObservationState` and the
 * deterministic run continues. A thrown error would convert a cosmetic gap
 * into a failed readiness run, which is the one thing a paid, optional,
 * non-dispositive feature must never do.
 */
async function resolveObservations<Kind extends string, Id extends string>(
  options: RunReadinessOptions,
  evidence: string,
  // The publisher's OWN parser, passed in so the returned state carries that
  // publisher's envelope type. A shared parser would widen it to `string` ids
  // and hand the grader an envelope it cannot tell apart from the other
  // publisher's.
  parse: (
    value: unknown,
  ) =>
    | { ok: true; envelope: DirectoryObservationEnvelope<Kind, Id> }
    | { ok: false; detail: string },
): Promise<DirectoryObservationState<Kind, Id>> {
  if (!options.requestObservations) {
    return {
      status: "not-requested",
      reason: "not_requested",
      detail:
        "this run did not request model-backed observations, so nothing was charged",
    };
  }

  const knownObservationReason = (
    reason: unknown,
  ): DirectoryObservationReason =>
    typeof reason === "string" &&
    (DIRECTORY_OBSERVATION_REASONS as readonly string[]).includes(reason)
      ? (reason as DirectoryObservationReason)
      : "provider_error";

  let answer: ObservationBrokerAnswer;
  try {
    answer = await options.requestObservations({
      publisher: options.publisher,
      evidence,
    });
  } catch (error) {
    // THE TWO STOP SIGNALS PASS THROUGH. Everything else becomes a gap,
    // because a paid, optional, non-dispositive feature must never fail a
    // deterministic grade — but a cancelled or reassigned run must not carry
    // on to a finalize that would overwrite somebody else's verdict.
    if (isStopSignal(error)) throw error;
    return {
      status: "provider-failed",
      reason: "provider_error",
      detail:
        error instanceof Error
          ? error.message.slice(0, 300)
          : String(error).slice(0, 300),
    };
  }

  if (answer.status !== "completed") {
    return {
      status: answer.status,
      // The backend's reason is carried through rather than re-derived. It is
      // what three surfaces branch on, and a second derivation here would be a
      // second chance to spell `billing_limit_reached` differently. CHECKED
      // against the union all the same, for the reason the status is: a
      // backend deployed ahead of this build could otherwise persist a value
      // the SDK never defined, into the one field readers switch on.
      reason: knownObservationReason(answer.reason),
      detail: answer.detail,
    };
  }

  // VALIDATED HERE, whatever the backend already did. The broker validated the
  // provider's output against its own mirror of the schema; this validates it
  // against the SDK's actual one. The two can drift — a backend deployed ahead
  // of an SDK build is the ordinary case — and the SDK's catalogue is the one
  // that decides what a finding may say.
  const parsed = parse(answer.envelope);
  if (!parsed.ok) {
    return {
      status: "invalid-output",
      reason: "schema_invalid",
      detail: parsed.detail,
    };
  }
  return { status: "completed", envelope: parsed.envelope };
}

export interface ReadinessRunOutcome {
  result: DirectoryReadinessResult;
  /** The observation axis, mirrored out so a caller can report it separately. */
  observations: DirectoryObservationState<string, string>;
}

/**
 * Run one readiness grade, end to end.
 *
 * The order is fixed and load-bearing: evidence is gathered FIRST, so the
 * observation prompt is built from what this run actually saw rather than from
 * the caller's description of the target — and so a run that could not reach
 * the server never pays for a model to read an empty surface.
 */
export async function runDirectoryReadiness(
  options: RunReadinessOptions,
): Promise<ReadinessRunOutcome> {
  assertNotCancelled(options.signal);

  if (options.publisher === "openai") {
    const mode = options.submissionMode;
    if (!mode) {
      // Never inferred. Inference reads a forgotten package as "MCP-only",
      // which reports the package lane `not-applicable` — a missing input
      // becoming a clean bill of health.
      throw new Error(
        "An OpenAI readiness run must declare its submission mode.",
      );
    }

    const evidence = await gatherOpenAIReadinessEvidence({
      target: options.target,
      mode,
      fetchFn: options.fetchFn,
      timeoutMs: options.timeoutMs,
      headers: options.headers,
      // Threaded IN, not merely checked between steps: a cancelled run has to
      // stop the request in flight, because the traffic being stopped is aimed
      // at somebody else's server.
      signal: options.signal,
      now: options.now,
    });
    assertNotCancelled(options.signal);

    const observations = await resolveObservations(
      options,
      renderObservationEvidence({
        target: options.target,
        tools: evidence.tools,
        skills: evidence.importedSkills?.skills,
      }),
      parseOpenAIExperienceObservations,
    );
    assertNotCancelled(options.signal);

    return {
      result: gradeOpenAIReadiness({
        ...evidence,
        llmObservations: observations,
      }),
      observations,
    };
  }

  const evidence = await gatherClaudeReadinessEvidence({
    enteredUrl: options.target,
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
    headers: options.headers,
    // Threaded IN, not merely checked between steps — see the OpenAI branch.
    signal: options.signal,
    now: options.now,
  });
  assertNotCancelled(options.signal);

  const observations = await resolveObservations(
    options,
    renderObservationEvidence({
      target: options.target,
      tools: evidence.tools,
    }),
    parseClaudeExperienceObservations,
  );
  assertNotCancelled(options.signal);

  return {
    result: gradeClaudeReadiness({
      ...evidence,
      llmObservations: observations,
    }),
    observations,
  };
}
