/**
 * The public projection of an iteration's code evaluator logs and setup and
 * cleanup script results, and of a run's own setup and cleanup script results
 * (EFTW-90), so an agent reading them through the API sees what the app shows
 * (amendment P8).
 *
 * A WHITELIST like every other projection here: known keys only, each
 * type-checked. OMITTED for an iteration or a run without them.
 */
export type ScriptResultDto = {
  status: string;
  exitCode?: number;
  output: string;
  durationMs?: number;
  error?: string;
};

export type CodeEvaluatorLogDto = {
  output: string;
  durationMs?: number;
  exitCode?: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function scriptResult(value: unknown): ScriptResultDto | undefined {
  const row = record(value);
  if (!row || typeof row.status !== "string") return undefined;
  return {
    status: row.status,
    output: typeof row.output === "string" ? row.output : "",
    ...(typeof row.exitCode === "number" ? { exitCode: row.exitCode } : {}),
    ...(typeof row.durationMs === "number"
      ? { durationMs: row.durationMs }
      : {}),
    ...(typeof row.error === "string" ? { error: row.error } : {}),
  };
}

export function toCodeGradingProjection(metadata: unknown): {
  codeEvaluatorLogs?: Record<string, CodeEvaluatorLogDto>;
  iterationScripts?: { setup?: ScriptResultDto; cleanup?: ScriptResultDto };
} {
  const meta = record(metadata);
  if (!meta) return {};
  const logs: Record<string, CodeEvaluatorLogDto> = {};
  for (const [scorerId, value] of Object.entries(
    record(meta.codeEvaluatorLogs) ?? {},
  )) {
    const row = record(value);
    if (!row || typeof row.output !== "string") continue;
    logs[scorerId] = {
      output: row.output,
      ...(typeof row.durationMs === "number"
        ? { durationMs: row.durationMs }
        : {}),
      ...(typeof row.exitCode === "number" ? { exitCode: row.exitCode } : {}),
    };
  }
  const scripts = record(meta.iterationScripts);
  const setup = scriptResult(scripts?.setup);
  const cleanup = scriptResult(scripts?.cleanup);
  return {
    ...(Object.keys(logs).length ? { codeEvaluatorLogs: logs } : {}),
    ...(setup || cleanup
      ? {
          iterationScripts: {
            ...(setup ? { setup } : {}),
            ...(cleanup ? { cleanup } : {}),
          },
        }
      : {}),
  };
}

/** A run's `scriptResults`: its run setup and run cleanup script outcomes. */
export function toRunScriptResultsProjection(scriptResults: unknown): {
  scriptResults?: { runSetup?: ScriptResultDto; runCleanup?: ScriptResultDto };
} {
  const scripts = record(scriptResults);
  const runSetup = scriptResult(scripts?.runSetup);
  const runCleanup = scriptResult(scripts?.runCleanup);
  return runSetup || runCleanup
    ? {
        scriptResults: {
          ...(runSetup ? { runSetup } : {}),
          ...(runCleanup ? { runCleanup } : {}),
        },
      }
    : {};
}
