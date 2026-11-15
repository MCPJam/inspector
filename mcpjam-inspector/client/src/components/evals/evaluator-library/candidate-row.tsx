import { cn } from "@/lib/utils";

export type CandidateVerdict = "confirmed" | "dismissed" | "allowed";

export type CandidateRowProps = {
  /** What the pattern matched, e.g. "Stripe secret key". */
  kind: string;
  /** The raw match. It is masked before display. */
  value: string;
  /** Where it appeared, e.g. "get_order result · payment.processor_key". */
  location: string;
  verdict: CandidateVerdict;
  /** The model's yes probability; absent when no model call was made. */
  probability?: number;
};

const VISIBLE_CHARS = 12;

/** Keeps the start of a match readable without showing the whole secret. */
export function maskCandidate(value: string): string {
  return value.length <= VISIBLE_CHARS
    ? value
    : `${value.slice(0, VISIBLE_CHARS)}…`;
}

const VERDICT: Record<CandidateVerdict, { label: string; className: string }> =
  {
    confirmed: {
      label: "Real",
      className: "bg-destructive/10 text-destructive",
    },
    dismissed: {
      label: "Ignored",
      className: "bg-muted text-muted-foreground",
    },
    allowed: {
      label: "Allowed by case",
      className: "border border-border text-muted-foreground",
    },
  };

/**
 * One item a code check found and what the model said about it. Values on
 * the case's allowed list are shown as allowed and never sent to a model.
 */
export function CandidateRow({
  kind,
  value,
  location,
  verdict,
  probability,
}: CandidateRowProps) {
  return (
    <div className="rounded-lg border border-border bg-popover p-3">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full",
            verdict === "confirmed" ? "bg-destructive" : "bg-muted-foreground",
          )}
        />
        <span className="text-sm font-medium text-card-foreground">{kind}</span>
        <span
          className={cn(
            "ml-auto inline-flex h-5 items-center rounded-sm px-1.5 text-[11px] font-semibold uppercase tracking-wide",
            VERDICT[verdict].className,
          )}
        >
          {VERDICT[verdict].label}
        </span>
      </div>
      <div className="mt-1.5 font-mono text-xs text-card-foreground">
        {maskCandidate(value)}
      </div>
      <div className="text-xs text-muted-foreground">{location}</div>
      {probability !== undefined ? (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="w-12 text-muted-foreground">Real?</span>
          <div
            role="meter"
            aria-label="Probability this is real"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={probability}
            className="h-1.5 w-28 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn(
                "h-full rounded-full",
                probability >= 0.5 ? "bg-destructive" : "bg-success",
              )}
              style={{ width: `${Math.round(probability * 100)}%` }}
            />
          </div>
          <span className="font-mono tabular-nums">
            {probability >= 0.5 ? "Yes" : "No"} · {probability.toFixed(2)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
