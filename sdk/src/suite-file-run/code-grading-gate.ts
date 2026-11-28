/**
 * A suite file run on this machine has no MCPJam sandboxes, so it can't run
 * code evaluators, setup and cleanup scripts or the grading box they need
 * (EFTW-90; running them locally is EFTW-91). The file is refused before
 * anything starts, rather than run without them and reported as if graded.
 */
import type { ResolvedEvalSuiteFile } from "../suite-file-loader.js";
import { SuiteFileRunError } from "./errors.js";

/** What this file declares that a local run can't honour, in the file's words. */
export function localCodeGradingFeatures(
  resolved: Pick<ResolvedEvalSuiteFile, "defaults">
): string[] {
  const { codeEvaluators, scripts, grading } = resolved.defaults;
  return [
    ...(codeEvaluators?.length ? ["defaults.codeEvaluators"] : []),
    ...(scripts && Object.values(scripts).some((s) => s?.trim())
      ? ["defaults.scripts"]
      : []),
    ...(grading?.files?.length || grading?.network === "web"
      ? ["defaults.grading"]
      : []),
  ];
}

export function assertLocalCodeGradingSupported(
  resolved: Pick<ResolvedEvalSuiteFile, "defaults">
): void {
  const features = localCodeGradingFeatures(resolved);
  if (features.length === 0) return;
  throw new SuiteFileRunError({
    code: "CODE_GRADING_UNSUPPORTED",
    phase: "validation",
    category: "unsupported",
    message: `This file's ${features.join(", ")} run only in MCPJam's cloud sandboxes, so nothing was run. Run it in the cloud with \`mcpjam cloud eval run --file\`.`,
    details: {
      problems: features.map((pointer) => ({
        pointer,
        reason: "sandboxOnly",
        message: `${pointer} needs MCPJam's cloud sandboxes.`,
      })),
    },
  });
}
