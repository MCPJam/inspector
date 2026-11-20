import {
  formatCreditRecovery,
  isCreditBlock,
  parseCreditRecovery,
  type CreditRecovery,
  type EvalResumeInstruction,
} from "@mcpjam/sdk";
import { isPlatformApiError } from "@mcpjam/sdk/platform";

/**
 * What a credit refusal a person must act on gives an agent: the one step
 * and, when the operation attached one, the exact call that resumes the
 * refused launch once that step is done. Only the re-parsed recovery and the
 * SDK-built `resume` leave the server envelope.
 */
interface CreditRefusal {
  creditRecovery: CreditRecovery;
  resume?: EvalResumeInstruction;
}

function isResumeInstruction(value: unknown): value is EvalResumeInstruction {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EvalResumeInstruction>;
  return (
    candidate.tool === "run_eval_suite" &&
    typeof candidate.arguments === "object" &&
    candidate.arguments !== null
  );
}

/** The credit refusal a thrown platform error carries, or `undefined`. */
export function creditRefusalOf(error: unknown): CreditRefusal | undefined {
  if (!isPlatformApiError(error)) return undefined;
  const recovery = parseCreditRecovery(error.details?.recovery);
  if (!isCreditBlock(recovery)) return undefined;
  const resume = error.details?.resume;
  return {
    creditRecovery: recovery,
    ...(isResumeInstruction(resume) ? { resume } : {}),
  };
}

/**
 * The text for a credit refusal: the one step unless the error message
 * already says it, then the one call to make after it. Hosts vary in whether
 * the model sees `structuredContent`, so it is in the text too. It never
 * suggests retrying on a timer.
 */
export function creditRefusalHint(
  refusal: CreditRefusal,
  message: string
): string | undefined {
  const step = formatCreditRecovery(refusal.creditRecovery);
  const parts = [
    message.includes(step) ? undefined : step,
    refusal.resume
      ? `Once that is done, call ${refusal.resume.tool} once with ${JSON.stringify(refusal.resume.arguments)}.`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
