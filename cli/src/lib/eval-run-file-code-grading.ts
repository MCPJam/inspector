/**
 * Code evaluators, scripts and grading settings on `cloud eval run --file`
 * (EFTW-90). The file is the source of truth, so a file without them should
 * clear them on the hosted suite. But the sync body is strict on every
 * Inspector older than this CLI, which is published on its own schedule, so
 * the fields can't simply be sent as `null` on every sync: that would refuse
 * every file run against an older Inspector.
 *
 * So the first sync names only what the file declares. An Inspector that
 * knows the fields reports them in its answer; when it reports stored ones
 * the file no longer has, a second sync clears them.
 */
import type { PlatformEvalSuiteDetail } from "@mcpjam/sdk/platform";

type FileDefaults = {
  codeEvaluators?: unknown[];
  scripts?: object;
  grading?: object;
};

/** The fields the file declares, for the first sync. */
export function declaredCodeGrading(
  defaults: FileDefaults,
): Record<string, unknown> {
  return {
    ...(defaults.codeEvaluators !== undefined
      ? { codeEvaluators: defaults.codeEvaluators }
      : {}),
    ...(defaults.scripts !== undefined ? { scripts: defaults.scripts } : {}),
    ...(defaults.grading !== undefined ? { grading: defaults.grading } : {}),
  };
}

/**
 * `null` for each field the hosted suite still holds and the file doesn't
 * declare, or `undefined` when nothing needs clearing (including on an
 * Inspector that doesn't report the fields at all).
 */
export function staleCodeGrading(
  defaults: FileDefaults,
  synced: Pick<PlatformEvalSuiteDetail, "settings">,
): Record<string, null> | undefined {
  const settings = synced.settings as Partial<
    Pick<
      PlatformEvalSuiteDetail["settings"],
      "codeEvaluators" | "scripts" | "grading"
    >
  >;
  const clear: Record<string, null> = {
    ...(defaults.codeEvaluators === undefined &&
    (settings.codeEvaluators?.length ?? 0) > 0
      ? { codeEvaluators: null }
      : {}),
    ...(defaults.scripts === undefined && settings.scripts
      ? { scripts: null }
      : {}),
    ...(defaults.grading === undefined && settings.grading
      ? { grading: null }
      : {}),
  };
  return Object.keys(clear).length > 0 ? clear : undefined;
}
