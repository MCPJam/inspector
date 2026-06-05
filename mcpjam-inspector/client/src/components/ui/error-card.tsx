import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Info,
  RefreshCw,
  X,
} from "lucide-react";
import { describeError, type NormalizedError } from "@mcpjam/sdk/browser";
import { cn } from "@/lib/utils";
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

function isNormalizedError(value: unknown): value is NormalizedError {
  // Require every field the render path dereferences. A partial payload
  // (e.g. stale wire shape that omits docsAnchor/severity/rawMessage)
  // must fall through to `describeError(input)`, which always produces a
  // complete `NormalizedError` — otherwise the "Learn more" anchor or
  // severity-based icon dereference would crash.
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { slug?: unknown }).slug === "string" &&
    typeof (value as { title?: unknown }).title === "string" &&
    typeof (value as { oneLine?: unknown }).oneLine === "string" &&
    typeof (value as { docsAnchor?: unknown }).docsAnchor === "string" &&
    typeof (value as { severity?: unknown }).severity === "string" &&
    typeof (value as { rawMessage?: unknown }).rawMessage === "string" &&
    Array.isArray((value as { likelyCauses?: unknown }).likelyCauses) &&
    Array.isArray((value as { nextSteps?: unknown }).nextSteps)
  );
}

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
        container:
          "border-destructive/20 bg-destructive/10 text-destructive",
        icon: CircleAlert,
        iconClass: "text-destructive",
      };
  }
}

export function ErrorCard({
  error,
  onRetry,
  onDismiss,
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
  const styles = severityStyles(normalized.severity);
  const Icon = styles.icon;

  const docsHref = normalized.docsAnchor.startsWith("/")
    ? `${DOCS_BASE_URL}${normalized.docsAnchor}`
    : normalized.docsAnchor;

  return (
    <div
      role="alert"
      className={cn(
        "rounded-md border p-3 text-xs",
        styles.container,
        variant === "banner" ? "shadow-sm" : "",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 h-4 w-4 flex-shrink-0", styles.iconClass)} />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <div className="font-medium leading-tight">{normalized.title}</div>
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
          <div className="flex items-center gap-3 pt-1">
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
