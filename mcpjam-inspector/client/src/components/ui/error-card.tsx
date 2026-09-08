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
   * One affordance that actually FIXES this error, rendered beside Retry.
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

function severityStyles(severity: NormalizedError["severity"]) {
  switch (severity) {
    case "info":
      return {
        container:
          "border-blue-300/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
        icon: Info,
        iconClass: "text-blue-500 dark:text-blue-400",
      };
    case "warning":
      return {
        container:
          "border-amber-300/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        icon: AlertTriangle,
        iconClass: "text-amber-500 dark:text-amber-400",
      };
    case "error":
    default:
      return {
        container: "border-destructive/20 bg-destructive/10 text-destructive",
        icon: CircleAlert,
        iconClass: "text-destructive",
      };
  }
}

/**
 * The card as plain text, for pasting into an agent or a bug report. Includes
 * the collapsed details: needing to expand them first would defeat the point.
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
 * The one thing a user staring at a red box most wants to know: is this my
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
        className: "border-foreground/20 bg-foreground/5 text-foreground/70",
      };
    case "mcpjam":
      return {
        label: "MCPJam issue",
        className: "border-destructive/30 bg-destructive/10 text-destructive",
        // Says only what the origin establishes. An earlier draft claimed the
        // error "has been reported", which this component cannot know: it
        // renders whatever `NormalizedError` it is handed and reports nothing
        // itself, and callers pass errors here from paths with no capture.
        note: "This one is on us — the failure is inside MCPJam, not your server or your configuration.",
      };
    default:
      return null;
  }
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

  return (
    <div
      role="alert"
      // dnd-kit server cards and ReactFlow nodes both eat the text selection
      // unless the card claims the gesture and opts out of their styles.
      onPointerDown={(event) => event.stopPropagation()}
      className={cn(
        "rounded-md border p-3 text-xs select-text nodrag nopan",
        styles.container,
        variant === "banner" ? "shadow-sm" : "",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <Icon
          className={cn("mt-0.5 h-4 w-4 flex-shrink-0", styles.iconClass)}
        />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium leading-tight">
                {normalized.title}
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
                className="ml-2 flex-shrink-0 rounded p-0.5 hover:bg-foreground/10"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <div className="text-foreground/80 leading-snug">
            {normalized.oneLine}
          </div>
          {badge?.note ? (
            <div className="text-foreground/70 leading-snug">{badge.note}</div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
            <button
              type="button"
              onClick={handleToggle}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground/70 hover:text-foreground"
            >
              {isOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {isOpen ? "Hide details" : "Show details"}
            </button>
            <button
              type="button"
              onClick={handleCopy}
              data-testid="error-card-copy"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground/70 hover:text-foreground"
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
            <a
              href={docsHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground/70 hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              Learn more
            </a>
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground/70 hover:text-foreground"
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            ) : null}
            {action ? (
              <button
                type="button"
                onClick={action.onClick}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground/70 hover:text-foreground"
                data-testid="error-card-action"
              >
                <ArrowRight className="h-3 w-3" />
                {action.label}
              </button>
            ) : null}
          </div>

          {isOpen ? (
            <div className="mt-2 space-y-2 rounded border border-foreground/10 bg-background/40 p-2 text-foreground/80">
              {normalized.likelyCauses.length > 0 ? (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">
                    Likely causes
                  </div>
                  <ul className="mt-1 list-disc pl-4 space-y-0.5">
                    {normalized.likelyCauses.map((cause, idx) => (
                      <li key={idx}>{cause}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {normalized.nextSteps.length > 0 ? (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">
                    Next steps
                  </div>
                  <ul className="mt-1 list-disc pl-4 space-y-0.5">
                    {normalized.nextSteps.map((step, idx) => (
                      <li key={idx}>{step}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">
                  Raw error
                </div>
                <div className="mt-1 break-all font-mono text-[11px] opacity-90">
                  {normalized.rawMessage}
                  {normalized.rawCode !== undefined
                    ? ` (code: ${normalized.rawCode})`
                    : ""}
                </div>
              </div>
              {normalized.cause ? (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">
                    Cause
                  </div>
                  <div className="mt-1 break-all font-mono text-[11px] opacity-90">
                    {normalized.cause.name}: {normalized.cause.message}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
