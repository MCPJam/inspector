export type PromptTurnToolCall = {
  toolName: string;
  arguments: Record<string, any>;
};

export type PromptTurn = {
  id: string;
  prompt: string;
  expectedToolCalls: PromptTurnToolCall[];
  expectedOutput?: string;
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
  return {
    id:
      typeof raw.id === "string" && raw.id.trim().length > 0
        ? raw.id.trim()
        : `turn-${index + 1}`,
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    expectedToolCalls: normalizeToolCalls(raw.expectedToolCalls),
    expectedOutput:
      typeof raw.expectedOutput === "string" ? raw.expectedOutput : undefined,
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
  if (!advancedConfig || typeof advancedConfig !== "object" || Array.isArray(advancedConfig)) {
    return [];
  }

  return normalizePromptTurns(
    (advancedConfig as { promptTurns?: unknown }).promptTurns,
  );
}

export function stripPromptTurnsFromAdvancedConfig(
  advancedConfig: unknown,
): Record<string, unknown> | undefined {
  if (!advancedConfig || typeof advancedConfig !== "object" || Array.isArray(advancedConfig)) {
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

  const legacyTurns = extractPromptTurnsFromAdvancedConfig(input.advancedConfig);
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

  return {
    query: firstTurn.prompt,
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
