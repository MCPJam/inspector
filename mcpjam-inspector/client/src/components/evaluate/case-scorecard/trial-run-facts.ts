/**
 * What one trial actually did, in the two tiers the data comes in.
 *
 * Tier 1 is on the iteration row itself — the tool sequence, tokens, turns,
 * duration — and needs no fetch. Tier 2 needs the trace blob: the final
 * answer, tool errors, which tools ran in which turn, what rendered, what a
 * click called. A suggestion built from Tier 2 can only be offered when the
 * blob was actually read, so every Tier 2 field is `undefined` rather than
 * empty when it was not: "no tool errored" and "we never looked" are
 * different claims, and only one of them is evidence.
 *
 * `successSignal` is the other half of that honesty. A claim that repeated
 * across three trials is only worth REQUIRING if those trials succeeded —
 * three runs that called the wrong tool also agree with each other.
 */

import type { EvalIteration } from "@/components/evals/types";
import type { JudgeCase } from "@/components/evals/goal-completion-presentation";
import type { TraceEnvelope } from "@/components/evals/trace-viewer-adapter";
import { buildPathKey } from "@mcpjam/sdk/contract";
import {
  extractFinalAssistantMessage,
  extractToolErrors,
  isSkillToolName,
  type ToolErrorRecord,
} from "@/shared/eval-matching";
import { caseRunBatchKey } from "@/components/evals/runs/group-case-iterations";

export type TrialReadState = "dto" | "full" | "failed";

/**
 * Why a trial counts as having succeeded, for the purpose of offering a
 * REQUIREMENT derived from it.
 *
 * `judge` — the judge scored it as accomplishing the goal.
 * `gates`  — the case already has a gate and the trial passed it.
 * `none`   — nothing established success; repetition alone is not evidence.
 */
export type SuccessSignal = "judge" | "gates" | "none";

export type TrialRunFacts = {
  iterationId: string;
  batchKey: string;
  iterationNumber: number;
  status: EvalIteration["status"];
  result: EvalIteration["result"];
  /** Terminal and trustworthy. Cancelled / timed out keep Tier 1 but hold nothing. */
  observed: boolean;
  readState: TrialReadState;
  successSignal: SuccessSignal;

  // ── Tier 1: always present ────────────────────────────────────────────────
  toolSequence: string[];
  toolSet: ReadonlySet<string>;
  pathKey: string;
  tokensTotal?: number;
  turnCount?: number;
  durationMs?: number;

  // ── Tier 2: present only when readState === "full" ────────────────────────
  /** `null` means read, and the trial ended with no assistant text. */
  finalMessage?: string | null;
  toolErrors?: ToolErrorRecord[];
  toolErrorsByTurn?: ReadonlyMap<number, ToolErrorRecord[]>;
  toolsByTurn?: ReadonlyMap<number, string[]>;
  turnSource?: "spans" | "prompts" | "dto-single-turn";
  renderedByTool?: ReadonlyMap<string, { rendered: number; total: number }>;
  clickCalls?: Array<{
    authoredStepId?: string;
    promptIndex: number;
    widgetToolName?: string;
    calledTools: string[];
    label?: string;
  }>;
};

type Span = {
  category?: unknown;
  status?: unknown;
  promptIndex?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  name?: unknown;
  startMs?: unknown;
};

function readSpans(blob: TraceEnvelope): Span[] {
  const spans = (blob as { spans?: unknown }).spans;
  return Array.isArray(spans) ? (spans as Span[]) : [];
}

/**
 * Tool spans that belong to a specific turn.
 *
 * The runner also emits a `"Tools (aggregate)"` span with `category: "tool"`
 * and NO `toolCallId`. Counting it would double every turn's tool list and
 * attribute a whole-run rollup to one turn, so the `toolCallId` test is what
 * separates a real call from the summary of all of them.
 */
function perTurnToolSpans(blob: TraceEnvelope): Span[] {
  return readSpans(blob)
    .filter(
      (span) =>
        span.category === "tool" &&
        typeof span.toolCallId === "string" &&
        typeof span.promptIndex === "number",
    )
    .sort(
      (a, b) =>
        (typeof a.startMs === "number" ? a.startMs : 0) -
        (typeof b.startMs === "number" ? b.startMs : 0),
    );
}

function spanToolName(span: Span): string | undefined {
  if (typeof span.toolName === "string" && span.toolName) return span.toolName;
  if (typeof span.name === "string" && span.name) return span.name;
  return undefined;
}

/** `blob.prompts`, only when it actually has the shape we would read. */
function readPromptTurns(
  blob: TraceEnvelope,
): Map<number, string[]> | undefined {
  const prompts = (blob as { prompts?: unknown }).prompts;
  if (!Array.isArray(prompts) || prompts.length === 0) return undefined;
  const out = new Map<number, string[]>();
  for (const entry of prompts) {
    if (!entry || typeof entry !== "object") return undefined;
    const record = entry as {
      promptIndex?: unknown;
      actualToolCalls?: unknown;
    };
    if (typeof record.promptIndex !== "number") return undefined;
    const calls = record.actualToolCalls;
    if (!Array.isArray(calls)) return undefined;
    const names: string[] = [];
    for (const call of calls) {
      const name = (call as { toolName?: unknown })?.toolName;
      if (typeof name !== "string") return undefined;
      if (!isSkillToolName(name)) names.push(name);
    }
    out.set(record.promptIndex, names);
  }
  return out;
}

export function trialFacts(
  iteration: EvalIteration,
  blob: TraceEnvelope | null,
  read: { state: "ok" | "failed" | "absent" },
  options?: {
    judgeCase?: JudgeCase | null;
    /** Whether the case this trial ran carries at least one gate. */
    authoredHasGate?: boolean;
    turnCountFromSteps?: number;
  },
): TrialRunFacts {
  const readState: TrialReadState =
    read.state === "ok" &&
    blob &&
    typeof blob === "object" &&
    !Array.isArray(blob)
      ? "full"
      : read.state === "failed"
        ? "failed"
        : "dto";

  const observed =
    iteration.status === "completed" || iteration.status === "failed";

  const toolSequence = (iteration.actualToolCalls ?? [])
    .map((call) => call.toolName)
    .filter((name) => typeof name === "string" && !isSkillToolName(name));

  const tokensTotal =
    iteration.usage?.totalTokens ??
    (iteration.tokensUsed > 0 ? iteration.tokensUsed : undefined);

  const rawTurnCount = (
    iteration.metadata as { turnCount?: unknown } | undefined
  )?.turnCount;
  const turnCount =
    typeof rawTurnCount === "number" &&
    Number.isFinite(rawTurnCount) &&
    rawTurnCount >= 0
      ? rawTurnCount
      : undefined;

  const durationMs =
    typeof iteration.startedAt === "number" &&
    Number.isFinite(iteration.updatedAt) &&
    iteration.updatedAt >= iteration.startedAt
      ? iteration.updatedAt - iteration.startedAt
      : undefined;

  const judge = options?.judgeCase;
  const successSignal: SuccessSignal =
    judge &&
    judge.status !== "error" &&
    judge.status !== "skipped" &&
    judge.passed
      ? "judge"
      : iteration.result === "passed" && options?.authoredHasGate
        ? "gates"
        : "none";

  const base: TrialRunFacts = {
    iterationId: iteration._id,
    batchKey: caseRunBatchKey(iteration),
    iterationNumber: iteration.iterationNumber,
    status: iteration.status,
    result: iteration.result,
    observed,
    readState,
    successSignal,
    toolSequence,
    toolSet: new Set(toolSequence),
    pathKey: buildPathKey(toolSequence),
    ...(tokensTotal !== undefined ? { tokensTotal } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };

  if (readState !== "full" || !blob) return base;

  const messages = (blob as { messages?: unknown }).messages;
  const finalText = extractFinalAssistantMessage(messages);
  const spans = readSpans(blob);
  const toolErrors = extractToolErrors({ messages, spans } as never);

  // Per-turn errors come from spans ONLY. A message-part error carries no
  // `promptIndex`, so it can be counted for the run but never attributed to a
  // turn; a per-turn "clean" that ignored it would be a false all-clear.
  const toolErrorsByTurn = new Map<number, ToolErrorRecord[]>();
  for (const span of perTurnToolSpans(blob)) {
    if (span.status !== "error") continue;
    const turn = span.promptIndex as number;
    const list = toolErrorsByTurn.get(turn) ?? [];
    const name = spanToolName(span);
    list.push({
      // A span-reported failure is the protocol side of the same union the
      // message-part scan produces; the engine only ever counts these.
      kind: "protocol-error",
      ...(name ? { toolName: name } : {}),
    });
    toolErrorsByTurn.set(turn, list);
  }

  // Precedence: real spans, then a structurally valid `blob.prompts`, then a
  // single-turn case where the DTO's own sequence IS turn 0. Anything else
  // leaves `toolsByTurn` undefined, which the engine reads as "unreadable"
  // and refuses to build a per-turn claim from.
  let toolsByTurn: Map<number, string[]> | undefined;
  let turnSource: TrialRunFacts["turnSource"];
  const spanTurns = perTurnToolSpans(blob);
  if (spanTurns.length > 0) {
    toolsByTurn = new Map();
    for (const span of spanTurns) {
      const name = spanToolName(span);
      if (!name || isSkillToolName(name)) continue;
      const turn = span.promptIndex as number;
      toolsByTurn.set(turn, [...(toolsByTurn.get(turn) ?? []), name]);
    }
    turnSource = "spans";
  } else {
    const fromPrompts = readPromptTurns(blob);
    if (fromPrompts) {
      toolsByTurn = fromPrompts;
      turnSource = "prompts";
    } else if (options?.turnCountFromSteps === 1) {
      toolsByTurn = new Map([[0, toolSequence]]);
      turnSource = "dto-single-turn";
    }
  }

  const observations = (blob as { widgetRenderObservations?: unknown })
    .widgetRenderObservations;
  const renderedByTool = new Map<string, { rendered: number; total: number }>();
  if (Array.isArray(observations)) {
    for (const raw of observations) {
      const row = raw as { toolName?: unknown; status?: unknown };
      if (typeof row.toolName !== "string") continue;
      const entry = renderedByTool.get(row.toolName) ?? {
        rendered: 0,
        total: 0,
      };
      entry.total += 1;
      // Only `rendered` counts — the same scoping rule the predicates list
      // uses. A mounted-but-errored view is not a rendered one.
      if (row.status === "rendered") entry.rendered += 1;
      renderedByTool.set(row.toolName, entry);
    }
  }

  const interactions = (blob as { browserInteractionSteps?: unknown })
    .browserInteractionSteps;
  const clickCalls: TrialRunFacts["clickCalls"] = [];
  if (Array.isArray(interactions)) {
    for (const raw of interactions) {
      const row = raw as {
        authoredStepId?: unknown;
        promptIndex?: unknown;
        widgetToolCalls?: unknown;
        locatorLabel?: unknown;
        toolCallId?: unknown;
      };
      if (
        !Array.isArray(row.widgetToolCalls) ||
        row.widgetToolCalls.length === 0
      ) {
        continue;
      }
      const calledTools = row.widgetToolCalls
        .filter((call) => (call as { ok?: unknown })?.ok !== false)
        .map((call) => (call as { name?: unknown })?.name)
        .filter((name): name is string => typeof name === "string");
      if (calledTools.length === 0) continue;
      const widgetToolName = Array.isArray(observations)
        ? (
            observations.find(
              (obs) =>
                (obs as { toolCallId?: unknown })?.toolCallId ===
                row.toolCallId,
            ) as { toolName?: unknown } | undefined
          )?.toolName
        : undefined;
      clickCalls.push({
        ...(typeof row.authoredStepId === "string"
          ? { authoredStepId: row.authoredStepId }
          : {}),
        promptIndex: typeof row.promptIndex === "number" ? row.promptIndex : 0,
        ...(typeof widgetToolName === "string" ? { widgetToolName } : {}),
        calledTools,
        ...(typeof row.locatorLabel === "string"
          ? { label: row.locatorLabel }
          : {}),
      });
    }
  }

  return {
    ...base,
    finalMessage: typeof finalText === "string" ? finalText : null,
    toolErrors,
    toolErrorsByTurn,
    ...(toolsByTurn ? { toolsByTurn } : {}),
    ...(turnSource ? { turnSource } : {}),
    renderedByTool,
    clickCalls,
  };
}
