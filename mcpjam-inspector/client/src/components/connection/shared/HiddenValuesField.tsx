import { Eye, Loader2 } from "lucide-react";

interface HiddenValuesFieldProps {
  /** What the click fetches, e.g. "environment variables". Reads as
   * "Reveal saved environment variables". */
  subject: string;
  isRevealing?: boolean;
  error?: string | null;
  onReveal?: () => void;
}

/**
 * Stand-in for values the server keeps redacted until they're asked for.
 *
 * Shaped like the value field it turns into, with the eye sitting in the same
 * place, so revealing reads as the row uncovering itself rather than as a
 * separate control firing. This is the idiom Vercel, Convex and Netlify use
 * for stored env vars: a masked field you click to decrypt, not a labelled
 * button beside a notice.
 *
 * The mask is a fixed twelve dots. The real length never reaches the client
 * before the reveal, and sending it would leak the size of a secret the viewer
 * can't yet see.
 */
export function HiddenValuesField({
  subject,
  isRevealing = false,
  error,
  onReveal,
}: HiddenValuesFieldProps) {
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={onReveal}
        disabled={isRevealing || !onReveal}
        aria-label={`Reveal saved ${subject}`}
        title={`Reveal saved ${subject}`}
        className="group relative flex h-8 w-full cursor-pointer items-center rounded-md border border-input bg-transparent pl-3 pr-9 text-left shadow-xs transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/30"
      >
        <span
          aria-hidden="true"
          className="select-none font-mono text-xs tracking-[0.2em] text-muted-foreground"
        >
          ••••••••••••
        </span>
        <span
          aria-hidden="true"
          className="absolute right-0.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors group-hover:text-foreground"
        >
          {isRevealing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </span>
      </button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
