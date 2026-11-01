import { useState } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, Loader2 } from "lucide-react";
import { decodeJWT } from "@/lib/oauth/jwt-decoder";
import { ScrollableJsonView } from "@/components/ui/json-editor";
import { CopyValueButton } from "./CopyValueButton";

interface TokenValueProps {
  label: string;
  value: string | undefined;
  /** Hidden behind a mask until its eye is clicked. Otherwise a long value
   * shows its first 50 characters until the row is clicked. */
  maskedByDefault?: boolean;
}

/**
 * One token on the Auth tab: an OAuth access, refresh or ID token, or a bearer
 * token. OAuth and bearer servers share it so a token reads, copies and
 * decodes the same way whichever method put it there.
 */
export function TokenValue({
  label,
  value,
  maskedByDefault = false,
}: TokenValueProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showDecoded, setShowDecoded] = useState(false);
  if (!value) return null;

  const isMasked = maskedByDefault && !isExpanded;
  const decoded =
    !isMasked && value.split(".").length === 3 ? decodeJWT(value) : null;
  const displayValue = isMasked
    ? "****************"
    : isExpanded || maskedByDefault || value.length <= 50
      ? value
      : `${value.substring(0, 50)}...`;

  return (
    <div>
      <span className="text-muted-foreground font-medium">{label}:</span>
      <div
        className="font-mono text-foreground break-all bg-background/50 p-2 rounded mt-1 group cursor-pointer hover:bg-background/70 transition-colors"
        onClick={() => setIsExpanded((expanded) => !expanded)}
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">{displayValue}</div>
          {maskedByDefault ? (
            <button
              type="button"
              aria-label={`${isExpanded ? "Hide" : "Reveal"} ${label}`}
              title={`${isExpanded ? "Hide" : "Reveal"} ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded((expanded) => !expanded);
              }}
              className="mt-0.5 flex-shrink-0 p-1 text-muted-foreground/60 hover:text-foreground transition-colors cursor-pointer"
            >
              {isExpanded ? (
                <EyeOff className="h-3 w-3" />
              ) : (
                <Eye className="h-3 w-3" />
              )}
            </button>
          ) : null}
          <CopyValueButton value={value} subject={label} size="inline" />
        </div>
      </div>
      {decoded && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setShowDecoded((shown) => !shown)}
            className="text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1"
          >
            {showDecoded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            View Decoded JWT
          </button>
          {showDecoded && (
            <ScrollableJsonView
              value={decoded}
              showLineNumbers={false}
              containerClassName="mt-1 max-h-96 rounded-lg"
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Fetches tokens the server keeps hidden until asked for. */
export function RevealTokensButton({
  label,
  isRevealing,
  disabled = false,
  onClick,
}: {
  /** e.g. "Reveal tokens". */
  label: string;
  /** This button's fetch is in flight: it shows a spinner. */
  isRevealing: boolean;
  /** Another fetch is in flight, or this one can't run. */
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isRevealing}
      className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
    >
      {isRevealing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {isRevealing ? "Revealing..." : label}
    </button>
  );
}

export function TokenRevealError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive"
    >
      {message}
    </div>
  );
}
