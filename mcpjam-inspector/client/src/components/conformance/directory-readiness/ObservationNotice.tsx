/**
 * The AI-observation axis, on its own line.
 *
 * It is independent of the run's status and of the grade, and rendering it as
 * part of either would state something false. The case that matters most is
 * `billing-blocked`: the deterministic grade is complete and valid, and the
 * only thing missing is the optional paid reading. Folding that into the
 * verdict would tell a submitter their server has a problem when what actually
 * happened is that we could not afford to look — the exact confusion the
 * machine-readable `billing_limit_reached` reason exists to prevent.
 *
 * So: never an error styling for a refused observation, and never silence
 * either. A row that says nothing reads as "we looked and it was fine".
 */

import { Info, Sparkles } from "lucide-react";

export interface ObservationState {
  status:
    | "not-requested"
    | "pending"
    | "completed"
    | "billing-blocked"
    | "provider-failed"
    | "invalid-output";
  reason?: string;
  detail?: string;
}

/**
 * What each state means to somebody reading a grade, in their terms.
 *
 * Keyed off `status` with `reason` only distinguishing the billing case,
 * because `reason` is the machine-readable field and string-matching `detail`
 * would break the moment the backend rewords a sentence.
 */
function describe(observations: ObservationState): {
  tone: "muted" | "info";
  text: string;
} | null {
  switch (observations.status) {
    case "not-requested":
      // The default. Saying "you did not ask for the paid thing" on every run
      // would be noise.
      return null;
    case "pending":
      return { tone: "muted", text: "AI observations are still running." };
    case "completed":
      return {
        tone: "info",
        text: "AI observations included — shown as non-blocking notes below.",
      };
    case "billing-blocked":
      return {
        tone: "info",
        text:
          observations.reason === "billing_limit_reached"
            ? "AI observations were skipped: this organization has reached its MCPJam model limit. The grade below is complete without them."
            : "AI observations were skipped for a billing reason. The grade below is complete without them.",
      };
    case "provider-failed":
      return {
        tone: "muted",
        text: "AI observations could not be produced — the model provider did not answer. The grade below is unaffected.",
      };
    case "invalid-output":
      return {
        tone: "muted",
        text: "AI observations were discarded because the model's answer did not match the expected shape. The grade below is unaffected.",
      };
    default:
      return null;
  }
}

export function ObservationNotice({
  observations,
}: {
  observations: ObservationState;
}) {
  const described = describe(observations);
  if (!described) return null;

  const Icon = observations.status === "completed" ? Sparkles : Info;
  return (
    <div
      className={`flex items-start gap-1.5 rounded-md border border-border/50 px-2 py-1.5 text-[10px] ${
        described.tone === "info"
          ? "text-foreground/80"
          : "text-muted-foreground"
      }`}
    >
      <Icon className="mt-0.5 h-3 w-3 flex-shrink-0" />
      <span>{described.text}</span>
    </div>
  );
}
