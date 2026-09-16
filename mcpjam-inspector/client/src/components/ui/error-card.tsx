import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  Info,
  RefreshCw,
  X,
} from "lucide-react";
import {
  describeError,
  isNormalizedError,
  originOf,
  type NormalizedError,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { WebApiError } from "@/lib/apis/web/base";

const DOCS_BASE_URL = "https://docs.mcpjam.com";

export type ErrorCardProps = {
  /**
   * Accepts the rich normalized form, a wrapped `WebApiError`, any
   * `Error`, or a raw string / unknown value. When `error` is already a
   * `NormalizedError` (or a `WebApiError` with a `.normalized` block)
   * the card renders that directly; otherwise it falls back to
   * `describeError(error)`.
   */
  error: NormalizedError | WebApiError | Error | string | unknown;
  onRetry?: () => void;
  onDismiss?: () => void;
  /**
   * One affordance that actually FIXES this error, rendered as the card's
   * primary button.
   *
   * Distinct from `onRetry` on purpose: retrying a deterministic failure —
   * "this environment has no servers" — just fails again identically. What the
   * user needs is a way to go add a server. Omit it when there is no such
   * action; a button that only navigates somewhere vaguely related is worse
   * than none.
   */
  action?: { label: string; onClick: () => void };
  variant?: "inline" | "banner" | "toast";
  /**
   * Uncontrolled initial state for the details disclosure. Ignored when
   * `open` is provided (controlled mode).
   */
  defaultOpen?: boolean;
  /**
   * Controlled details-disclosure state. When set, the card renders this
   * value instead of its internal state and forwards toggles to
   * `onOpenChange`. Pair with `onOpenChange` to keep the toggle reactive.
   */
  open?: boolean;
  /**
   * Fired whenever the user toggles the details disclosure. Called in
   * both controlled and uncontrolled modes.
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * Optional extra class to merge into the root container. Lets callers
   * tighten spacing without re-styling the whole card.
   */
  className?: string;
};

function resolveNormalized(input: unknown): NormalizedError {
  if (isNormalizedError(input)) return input;
  // Re-validate the WebApiError-attached block with the same shape guard
  // before trusting it. `webPost` populates `WebApiError.normalized` from
  // any `typeof === "object"` value in the response body, so a partial
  // payload (older server, future schema drift, proxy mangling) would
  // otherwise crash the render at `docsAnchor.startsWith` / `severity`.
  if (input instanceof WebApiError && isNormalizedError(input.normalized)) {
    return input.normalized;
  }
  return describeError(input);
}

/**
 * The app's severity palette, and the thing the design system's ErrorCard
 * node documents by name (Figma `Design System — MCPJam App`, node 119-2).
 *
 * Exported because that node is what product points at when it asks for "the
 * blue informational treatment" — `SwarmProductionNotice` reads `info` from
 * here rather than restating the class strings, so the palette has one home
 * and a change to it cannot leave a sibling surface behind. Consumers outside
 * this card want the STYLES only; the card's own error-reporting affordances
 * (details, copy, docs, `role="alert"`) are not part of the contract.
 *
 * Two treatments of one palette, because the two surfaces are doing different
 * jobs:
 *
 * - `container` is the FILLED panel. It suits a standing notice that is the
 *   only coloured thing on an otherwise healthy screen, which is exactly
 *   `SwarmProductionNotice`'s case.
 * - `accent` is a hairline left rule meant to sit on a NEUTRAL surface, and
 *   it is what this card wears. Filling the card put a saturated red box
 *   inside a server card that already showed a red status dot, a red "Failed"
 *   label and a red badge, so one recoverable state lit up four separate
 *   alarms and the surface read as broken rather than informative.
 *
 * Both are kept deliberately. Colour should answer "how bad" once per screen,
 * and which treatment does that depends on what else is already coloured
 * around it — that is the caller's knowledge, not the palette's.
 */
export function severityStyles(severity: NormalizedError["severity"]) {
  switch (severity) {
    case "info":
      return {
        container:
          "border-blue-300/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
        accent: "border-l-blue-500/60",
        icon: Info,
        iconClass: "text-blue-600 dark:text-blue-400",
      };
    case "warning":
      return {
        container:
          "border-amber-300/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        accent: "border-l-amber-500/60",
        icon: AlertTriangle,
        iconClass: "text-amber-600 dark:text-amber-400",
      };
    case "error":
    default:
      return {
        container: "border-destructive/20 bg-destructive/10 text-destructive",
        accent: "border-l-destructive/60",
        icon: CircleAlert,
        iconClass: "text-destructive",
      };
  }
}

/**
 * The card as plain text, for pasting into an agent or a bug report. Includes
 * the collapsed details: needing to expand them first would defeat the point.
 *
 * Deliberately NOT filtered the way the rendered panel is. The panel drops a
 * raw message that only repeats the headline because it is noise to a reader
 * who just read the headline; a bug report wants the literal string that came
 * off the wire regardless, so this keeps every field.
 */
function copyText(normalized: NormalizedError): string {
  const lines = [normalized.title, normalized.oneLine];
  if (normalized.likelyCauses.length > 0) {
    lines.push(
      "",
      "Likely causes:",
      ...normalized.likelyCauses.map((cause) => `- ${cause}`),
    );
  }
  if (normalized.nextSteps.length > 0) {
    lines.push(
      "",
      "Next steps:",
      ...normalized.nextSteps.map((step) => `- ${step}`),
    );
  }
  lines.push(
    "",
    `Raw error: ${normalized.rawMessage}${
      normalized.rawCode !== undefined ? ` (code: ${normalized.rawCode})` : ""
    }`,
  );
  if (normalized.cause) {
    lines.push(`Cause: ${normalized.cause.name}: ${normalized.cause.message}`);
  }
  return lines.join("\n");
}

/**
 * The one thing a user staring at an error most wants to know: is this my
 * problem or theirs?
 *
 * Deliberately narrow. The BADGE comes from `origin`; the explanation of what
 * to actually do does NOT — it stays in the catalog's own `oneLine` /
 * `likelyCauses` / `nextSteps`, which are written per slug and already state
 * the ambiguity a slug carries. Writing per-origin prose here would flatten
 * that: `transport/econnrefused` is `user_config`, but whether the server is
 * down or the port is wrong is exactly what its catalog entry spells out and
 * a generic "check your configuration" would erase.
 *
 * `user_server` and `user_config` share one badge on purpose. The distinction
 * matters to capture policy, not to the person reading the card — both mean
 * "waiting on MCPJam will not fix this".
 *
 * Returns `null` — no badge at all — for two distinct cases that both mean
 * "no claim to make": an `ambiguous` origin, and an origin that is missing
 * entirely (a normalized payload from an older server, which crosses the wire
 * without the field). Guessing in either case is worse than staying quiet.
 */
function originBadge(
  normalized: NormalizedError,
): { label: string; className: string; note?: string } | null {
  if (normalized.origin === undefined) return null;
  // Read through `originOf` rather than the raw field: the value crossed a
  // wire and an unrecognized string must degrade to "no claim", not render.
  switch (originOf(normalized)) {
    case "user_server":
    case "user_config":
      return {
        label: "Not an MCPJam outage",
        className: "border-border bg-muted/60 text-muted-foreground",
      };
    case "mcpjam":
      return {
        label: "MCPJam issue",
        className: "border-destructive/30 bg-destructive/10 text-destructive",
        // Says only what the origin establishes. An earlier draft claimed the
        // error "has been reported", which this component cannot know: it
        // renders whatever `NormalizedError` it is handed and reports nothing
        // itself, and callers pass errors here from paths with no capture.
        //
        // Stays on the COLLAPSED face, unlike everything else that moved
        // behind the disclosure: it is an admission of fault, and hiding an
        // admission one click deep is the wrong default.
        note: "This one is on us — the failure is inside MCPJam, not your server or your configuration.",
      };
    default:
      return null;
  }
}

/**
 * `internal/unknown` is the describer's "no idea" bucket, and its catalog copy
 * is written for us, not for the user: the causes read "Unhandled error path"
 * and the next steps say to file an issue so we can add it to the catalog.
 * Shown to a customer under a red heading, that is the product admitting it
 * has nothing to say, at length.
 *
 * For this slug only, the card drops those two sections and keeps the raw
 * evidence. Scoped by slug so no real catalog entry is ever suppressed.
 */
const UNKNOWN_SLUG = "internal/unknown";

/**
 * `describeError` already promotes an unclassified raw message into `oneLine`
 * (see `maybePromoteRawMessage`), so the body carries the real text and the
 * title is free to say what kind of thing happened. "Unknown error" as a
 * headline reads as a crash; it is usually an ordinary connection failure we
 * simply have not catalogued.
 *
 * Only when there is no raw text at all do we admit to knowing nothing.
 */
function displayTitle(normalized: NormalizedError): string {
  if (normalized.slug !== UNKNOWN_SLUG) return normalized.title;
  return normalized.rawMessage.trim() ? "Connection error" : normalized.title;
}

/**
 * The raw row earns its place only by carrying something the reader has not
 * already seen. When the describer promoted the raw message into `oneLine`,
 * repeating it verbatim under a "RAW ERROR" heading is the same sentence
 * twice — which is what made the expanded panel look padded.
 *
 * A `rawCode` is always new information, so its presence alone keeps the row.
 */
function shouldShowRaw(normalized: NormalizedError): boolean {
  if (normalized.rawCode !== undefined) return true;
  const raw = normalized.rawMessage.trim();
  if (!raw) return false;
  return raw !== normalized.oneLine.trim() && raw !== normalized.title.trim();
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * One item is a statement; several are a list. Bulleting a single sentence
 * makes a definite answer look like the first of several guesses.
 */
function SectionBody({ items }: { items: string[] }) {
  if (items.length === 1) {
    return <p className="mt-1 leading-relaxed text-foreground">{items[0]}</p>;
  }
  return (
    <ul className="mt-1 list-disc space-y-1 pl-4 text-foreground">
      {items.map((item, idx) => (
        <li key={idx} className="leading-relaxed">
          {item}
        </li>
      ))}
    </ul>
  );
}

/**
 * `break-words`, never `break-all`. `break-all` splits inside words at the
 * exact column the box ends, which turned "Reconnect" into "R / econnect" and
 * made ordinary prose look like corrupted output.
 */
function MonoBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
      {children}
    </div>
  );
}

export function ErrorCard({
  error,
  onRetry,
  onDismiss,
  action,
  variant = "inline",
  defaultOpen = false,
  open,
  onOpenChange,
  className,
}: ErrorCardProps) {
  const normalized = useMemo(() => resolveNormalized(error), [error]);
  // Support both controlled (`open` provided) and uncontrolled (`defaultOpen`)
  // modes. `useState` only reads `defaultOpen` once at mount, so callers that
  // need the toggle to react to outside state must use the controlled form.
  const [uncontrolledOpen, setUncontrolledOpen] =
    useState<boolean>(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : uncontrolledOpen;
  const handleToggle = () => {
    const next = !isOpen;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    [],
  );
  const handleCopy = async () => {
    // `copyToClipboard` reports failure by returning false, not by throwing.
    const copied = await copyToClipboard(copyText(normalized));
    setCopyState(copied ? "copied" : "failed");
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopyState("idle"), 2000);
  };
  const styles = severityStyles(normalized.severity);
  const Icon = styles.icon;
  const badge = originBadge(normalized);

  const docsHref = normalized.docsAnchor.startsWith("/")
    ? `${DOCS_BASE_URL}${normalized.docsAnchor}`
    : normalized.docsAnchor;

  const isUnknown = normalized.slug === UNKNOWN_SLUG;
  const causes = isUnknown ? [] : normalized.likelyCauses;
  const steps = isUnknown ? [] : normalized.nextSteps;
  const showRaw = shouldShowRaw(normalized);
  /**
   * Whether the panel holds anything beyond its own docs link. When it does
   * not, a "Show details" control promises evidence and then opens onto a
   * separator and a link — so the link comes out to the action row instead
   * and the disclosure is not offered at all.
   */
  const hasDetail =
    causes.length > 0 || steps.length > 0 || showRaw || Boolean(normalized.cause);

  return (
    <div
      role="alert"
      // dnd-kit server cards and ReactFlow nodes both eat the text selection
      // unless the card claims the gesture and opts out of their styles.
      onPointerDown={(event) => event.stopPropagation()}
      className={cn(
        "rounded-lg border border-l-2 border-border bg-muted/40 p-3 text-xs select-text nodrag nopan dark:bg-muted/20",
        styles.accent,
        variant === "banner" ? "shadow-sm" : "",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className={cn("mt-0.5 h-4 w-4 flex-shrink-0", styles.iconClass)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium leading-tight text-foreground">
                {displayTitle(normalized)}
              </span>
              {badge ? (
                <span
                  data-testid="error-card-origin-badge"
                  className={cn(
                    "rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none",
                    badge.className,
                  )}
                >
                  {badge.label}
                </span>
              ) : null}
            </div>
            {onDismiss ? (
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss"
                className="ml-2 flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-chrome-hover hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>

          <div className="mt-1 leading-relaxed text-muted-foreground">
            {normalized.oneLine}
          </div>

          {badge?.note ? (
            <div className="mt-1 leading-relaxed text-muted-foreground">
              {badge.note}
            </div>
          ) : null}

          {/* Collapsed face carries what FIXES the error, the way in to the
              evidence, and Copy.
              Copy stays out here deliberately: `copyText` serializes the whole
              card including the collapsed rows, precisely so someone pasting
              into an agent never has to expand anything first. Putting it
              behind the disclosure would undo that. "Learn more" is reading,
              not repair, so it sits in the panel with the rest of the detail. */}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
            {action ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={action.onClick}
                data-testid="error-card-action"
              >
                {action.label}
                <ArrowRight className="h-3 w-3" />
              </Button>
            ) : null}
            {onRetry ? (
              <Button
                type="button"
                variant={action ? "ghost" : "secondary"}
                size="sm"
                onClick={onRetry}
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </Button>
            ) : null}
            {hasDetail ? (
              <button
                type="button"
                onClick={handleToggle}
                aria-expanded={isOpen}
                className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {isOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                {isOpen ? "Hide details" : "Show details"}
              </button>
            ) : (
              <a
                href={docsHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
                Learn more
              </a>
            )}
            <button
              type="button"
              onClick={handleCopy}
              data-testid="error-card-copy"
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {copyState === "copied" ? (
                <Check className="h-3 w-3" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
              {copyState === "copied"
                ? "Copied"
                : copyState === "failed"
                  ? "Copy failed"
                  : "Copy"}
            </button>
          </div>

          {isOpen && hasDetail ? (
            <div className="mt-3 space-y-3 border-t border-border pt-3">
              {causes.length > 0 ? (
                <div>
                  {/* A list means the wire genuinely doesn't settle which one
                      it was; a single entry means we know. Saying "likely"
                      over a cause we're certain of reads as the product not
                      knowing its own state. Not "Cause": that heading is
                      taken below by the nested exception, and one panel
                      cannot use it for two different things. */}
                  <SectionLabel>
                    {causes.length === 1
                      ? "Why this happened"
                      : "Likely causes"}
                  </SectionLabel>
                  <SectionBody items={causes} />
                </div>
              ) : null}
              {steps.length > 0 ? (
                <div>
                  <SectionLabel>Next steps</SectionLabel>
                  <SectionBody items={steps} />
                </div>
              ) : null}
              {showRaw ? (
                <div>
                  <SectionLabel>Raw error</SectionLabel>
                  <MonoBlock>
                    {normalized.rawMessage}
                    {normalized.rawCode !== undefined ? (
                      <span className="ml-1.5 rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
                        {normalized.rawCode}
                      </span>
                    ) : null}
                  </MonoBlock>
                </div>
              ) : null}
              {normalized.cause ? (
                <div>
                  <SectionLabel>Cause</SectionLabel>
                  <MonoBlock>
                    {normalized.cause.name}: {normalized.cause.message}
                  </MonoBlock>
                </div>
              ) : null}

              <div className="pt-0.5">
                <a
                  href={docsHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ExternalLink className="h-3 w-3" />
                  Learn more
                </a>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
