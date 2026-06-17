import type { ProbeConfig } from "./probe-config";

export type PromptTurnToolCall = {
  toolName: string;
  arguments: Record<string, any>;
};

/**
 * A pinned tool call attached to a turn. When present, the turn is model-free:
 * the runner executes this exact call (fixture input) instead of asking the
 * model. Same shape as a legacy widget-probe's {@link ProbeConfig}; the field
 * is wired onto {@link PromptTurn} in a later PR (Convex validator mirrored at
 * the same time). Selectors below read it structurally so they compile before
 * the typed field exists.
 */
export type PinnedToolCall = ProbeConfig;

export type PromptTurn = {
  id: string;
  prompt: string;
  expectedToolCalls: PromptTurnToolCall[];
  expectedOutput?: string;
  /**
   * When present, this turn is model-free: the runner executes this exact tool
   * call (fixture input) and renders its widget, with no LLM in the loop. The
   * Convex validator + write paths are wired in a later PR; the type lands here
   * so the runner and selectors can read it.
   */
  pinnedToolCall?: PinnedToolCall;
};

function normalizeToolCalls(value: unknown): PromptTurnToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof (item as { toolName?: unknown }).toolName === "string",
    )
    .map((item) => {
      const call = item as { toolName: string; arguments?: unknown };
      return {
        toolName: call.toolName,
        arguments:
          call.arguments && typeof call.arguments === "object"
            ? (call.arguments as Record<string, any>)
            : {},
      };
    });
}

function normalizePromptTurn(value: unknown, index: number): PromptTurn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const pinnedToolCall = raw.pinnedToolCall;
  return {
    id:
      typeof raw.id === "string" && raw.id.trim().length > 0
        ? raw.id.trim()
        : `turn-${index + 1}`,
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    expectedToolCalls: normalizeToolCalls(raw.expectedToolCalls),
    expectedOutput:
      typeof raw.expectedOutput === "string" ? raw.expectedOutput : undefined,
    // Preserve a pinned tool call through normalization (round-tripped from
    // storage and synthesized from legacy probes). Structurally validated by
    // the route/Convex layer, not here.
    ...(pinnedToolCall && typeof pinnedToolCall === "object"
      ? { pinnedToolCall: pinnedToolCall as PinnedToolCall }
      : {}),
  };
}

export function normalizePromptTurns(value: unknown): PromptTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((turn, index) => normalizePromptTurn(turn, index))
    .filter((turn): turn is PromptTurn => turn !== null);
}

export function extractPromptTurnsFromAdvancedConfig(
  advancedConfig: unknown,
): PromptTurn[] {
  if (
    !advancedConfig ||
    typeof advancedConfig !== "object" ||
    Array.isArray(advancedConfig)
  ) {
    return [];
  }

  return normalizePromptTurns(
    (advancedConfig as { promptTurns?: unknown }).promptTurns,
  );
}

export function stripPromptTurnsFromAdvancedConfig(
  advancedConfig: unknown,
): Record<string, unknown> | undefined {
  if (
    !advancedConfig ||
    typeof advancedConfig !== "object" ||
    Array.isArray(advancedConfig)
  ) {
    return undefined;
  }

  const { promptTurns: _promptTurns, ...rest } = advancedConfig as Record<
    string,
    unknown
  >;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export function packPromptTurnsIntoAdvancedConfig(
  advancedConfig: unknown,
  promptTurns: PromptTurn[],
): Record<string, unknown> {
  return {
    ...(stripPromptTurnsFromAdvancedConfig(advancedConfig) ?? {}),
    promptTurns,
  };
}

export function resolvePromptTurns(input: {
  promptTurns?: unknown;
  advancedConfig?: unknown;
  query?: string;
  expectedToolCalls?: unknown;
  expectedOutput?: string;
}): PromptTurn[] {
  const topLevelTurns = normalizePromptTurns(input.promptTurns);
  if (topLevelTurns.length > 0) {
    return topLevelTurns;
  }

  const legacyTurns = extractPromptTurnsFromAdvancedConfig(
    input.advancedConfig,
  );
  if (legacyTurns.length > 0) {
    return legacyTurns;
  }

  return [
    {
      id: "turn-1",
      prompt: typeof input.query === "string" ? input.query : "",
      expectedToolCalls: normalizeToolCalls(input.expectedToolCalls),
      expectedOutput: input.expectedOutput,
    },
  ];
}

export function deriveLegacyPromptFields(promptTurns: PromptTurn[]): {
  query: string;
  expectedToolCalls: PromptTurnToolCall[];
  expectedOutput?: string;
} {
  const firstTurn = promptTurns[0] ?? {
    id: "turn-1",
    prompt: "",
    expectedToolCalls: [],
  };

  // A pinned-first turn has an empty `prompt`, which would leave the legacy
  // `query` empty — breaking display, dedup/upsert identity, and validators
  // that require a non-empty query. Synthesize a stable descriptive query
  // from the pinned call instead.
  const query =
    firstTurn.prompt.trim().length === 0 && firstTurn.pinnedToolCall
      ? `Pinned tool call: ${firstTurn.pinnedToolCall.toolName} on "${firstTurn.pinnedToolCall.serverName}"`
      : firstTurn.prompt;

  return {
    query,
    expectedToolCalls: firstTurn.expectedToolCalls,
    expectedOutput: firstTurn.expectedOutput,
  };
}

type AssertedExpectedInput = {
  promptTurns?: unknown;
  advancedConfig?: unknown;
  query?: string;
  expectedToolCalls?: unknown;
  expectedOutput?: string;
  isNegativeTest?: boolean;
};

/**
 * Expected tool calls aggregated for display (e.g. Tools tab), aligned with
 * `evaluateMultiTurnResults`: concatenate expected tools from every turn that
 * asserts at least one tool. Negative tests expose no expected calls; the legacy
 * top-level `expectedToolCalls` is ignored when `promptTurns` is present.
 */
export function flattenAssertedExpectedToolCalls(
  input: AssertedExpectedInput,
): PromptTurnToolCall[] {
  if (input.isNegativeTest === true) {
    return [];
  }
  const turns = resolvePromptTurns(input);
  return turns
    .filter((turn) => turn.expectedToolCalls.length > 0)
    .flatMap((turn) => turn.expectedToolCalls);
}

/** Prefer a completed iteration snapshot; otherwise use the case template (e.g. unsaved run). */
export function resolveIterationDisplayExpectedToolCalls(
  snapshot: AssertedExpectedInput | null | undefined,
  fallbackTestCase: AssertedExpectedInput | null | undefined,
): PromptTurnToolCall[] {
  if (snapshot) {
    return flattenAssertedExpectedToolCalls({
      promptTurns: snapshot.promptTurns,
      advancedConfig: snapshot.advancedConfig,
      query: snapshot.query,
      expectedToolCalls: snapshot.expectedToolCalls,
      expectedOutput: snapshot.expectedOutput,
      isNegativeTest: snapshot.isNegativeTest,
    });
  }
  if (fallbackTestCase) {
    return flattenAssertedExpectedToolCalls({
      promptTurns: fallbackTestCase.promptTurns,
      advancedConfig: fallbackTestCase.advancedConfig,
      query: fallbackTestCase.query,
      expectedToolCalls: fallbackTestCase.expectedToolCalls,
      expectedOutput: fallbackTestCase.expectedOutput,
      isNegativeTest: fallbackTestCase.isNegativeTest,
    });
  }
  return [];
}

export function hasMultipleTurns(input: {
  promptTurns?: unknown;
  advancedConfig?: unknown;
  query?: string;
  expectedToolCalls?: unknown;
  expectedOutput?: string;
}): boolean {
  return resolvePromptTurns(input).length > 1;
}

export function countAssertedTurns(promptTurns: PromptTurn[]): number {
  return promptTurns.filter((turn) => turn.expectedToolCalls.length > 0).length;
}

// ──────────────────────────────────────────────────────────────────────────
// Pinned-turn selectors
//
// A "pinned tool call" turn is model-free: the runner executes a fixed tool
// call and renders its widget, with no LLM in the loop. These selectors are
// the single source of truth for "is this model-free?" across the server
// runner, the route-level cap math, and the client. They read the per-turn
// `pinnedToolCall` field structurally (it lands as a typed field in a later
// PR) and fall back to the legacy `caseType === "widget_probe"` representation
// so they return correct answers today — before any per-turn pinned data
// exists. Once the legacy shape is retired, the `caseType` branch is the only
// thing that needs removing.
// ──────────────────────────────────────────────────────────────────────────

/** Minimal structural view of a turn for pinned detection. */
type MaybePinnedTurn = { pinnedToolCall?: unknown };

/** Minimal structural view of a case for the case-level selectors. */
export type PinnedCaseInput = {
  /** Legacy discriminator; `"widget_probe"` ⇒ a single pinned tool call. */
  caseType?: string | null;
  /** Turn list (raw wire/snapshot shape; not necessarily normalized). */
  promptTurns?: unknown;
};

/** Raw turn list without dropping unknown fields like `pinnedToolCall`. */
function rawTurns(promptTurns: unknown): MaybePinnedTurn[] {
  return Array.isArray(promptTurns)
    ? (promptTurns as MaybePinnedTurn[])
    : [];
}

/** True when this turn carries a pinned tool call (model-free). */
export function isPinnedTurn(turn: unknown): boolean {
  return !!(turn && (turn as MaybePinnedTurn).pinnedToolCall);
}

/** True when any turn in the list is pinned. */
export function hasPinnedTurn(promptTurns: unknown): boolean {
  return rawTurns(promptTurns).some(isPinnedTurn);
}

/**
 * True when the case is entirely model-free (no model turns).
 *
 * - No authored turns: a legacy `widget_probe`'s `probeConfig` IS the single
 *   model-free pinned call, so it's pinned-only; any other empty case is a
 *   model case.
 * - Authored turns: pinned-only iff EVERY turn is pinned. This intentionally
 *   does NOT short-circuit on `caseType === "widget_probe"` — a widget_probe
 *   that also carries model prompt turns (a hybrid) must be treated as
 *   model-driven, or it would route model-free and then throw when the loop
 *   reaches a model turn with no LLM setup.
 */
export function isPinnedOnly(input: PinnedCaseInput): boolean {
  const turns = rawTurns(input.promptTurns);
  if (turns.length === 0) return input.caseType === "widget_probe";
  return turns.every(isPinnedTurn);
}

/** True when at least one turn needs the model (the inverse of pinned-only). */
export function needsModel(input: PinnedCaseInput): boolean {
  return !isPinnedOnly(input);
}

/** Number of model-driven (non-pinned) turns — the unit the LLM-call cap counts. */
export function countModelTurns(promptTurns: unknown): number {
  return rawTurns(promptTurns).filter((turn) => !isPinnedTurn(turn)).length;
}

/**
 * Adapt a legacy {@link ProbeConfig} into the single pinned turn it is
 * equivalent to. Used by the runner to route widget-probe rows through the
 * unified engine before the data model is migrated.
 */
export function legacyProbeToPinnedTurn(
  probeConfig: ProbeConfig,
): PromptTurn & { pinnedToolCall: PinnedToolCall } {
  return {
    id: "turn-1",
    prompt: "",
    expectedToolCalls: [],
    pinnedToolCall: { ...probeConfig },
  };
}

/**
 * Resolve a case's turns, surfacing a legacy `widget_probe` row's top-level
 * `probeConfig` as a single pinned turn so callers see ONE shape. No-op for
 * already-pinned / prompt cases. Shared by the editor (editForm seeding) and
 * the runner (`normalizeTestForPinnedTurns`) so the legacy-detection rule lives
 * in one place.
 */
export function resolvePromptTurnsWithLegacyProbe(
  input: {
    caseType?: string | null;
    probeConfig?: ProbeConfig;
  } & Parameters<typeof resolvePromptTurns>[0],
): PromptTurn[] {
  const turns = resolvePromptTurns(input);
  // Only surface the legacy probeConfig as a pinned turn when the case carries
  // NO real authored turn — i.e. a pure legacy probe (empty prompt, no expected
  // calls, none already pinned). A widget_probe that also has real prompt steps
  // must keep them; replacing the whole list would silently drop them in the
  // editor and at run time.
  const hasRealTurn = turns.some(
    (t) =>
      isPinnedTurn(t) ||
      t.prompt.trim().length > 0 ||
      t.expectedToolCalls.length > 0,
  );
  if (input.caseType === "widget_probe" && input.probeConfig && !hasRealTurn) {
    return [legacyProbeToPinnedTurn(input.probeConfig)];
  }
  return turns;
}
