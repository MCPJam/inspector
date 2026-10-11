import { useEffect, useState } from "react";
import { toast as sonnerToast } from "sonner";
import { Check, Copy } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { track } from "@/lib/analytics";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { isProtocolVersionPinFailure } from "@/lib/protocol-version-pin";
import { splitSupportReference } from "@/lib/convex-error";

/**
 * App-wide toast.
 *
 * Identical to Sonner's `toast`, except error toasts stay up longer than
 * Sonner's ~4s default (the global `<Toaster>` also enables a close button
 * for anyone who wants to dismiss sooner). Errors are the one toast type
 * users must read and usually act on, so they get more time than
 * success/info toasts — but they still time out on their own; nothing should
 * require a manual close to go away.
 *
 * Error toasts also get a copy button (visible on hover, via the `<Toaster>`'s
 * `group/toast` class) so long/unreadable error text can be grabbed and
 * pasted elsewhere rather than retyped.
 *
 * Callers can still override the duration per-call by passing `duration`
 * explicitly in the options.
 *
 * Import `toast` from here rather than from "sonner" directly so error toasts
 * stay consistent across the app.
 */
function CopyableErrorMessage({
  text,
  copyText,
}: {
  text: string;
  /** What the button writes, when that is more than the line it sits on. */
  copyText?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    // `min-h-5` matches the button: a 19.5px line under a 20px button
    // overflows, and raises a native scrollbar inside `[data-content]`.
    <div className="relative min-h-5 pr-7">
      <span className="whitespace-pre-wrap break-words">{text}</span>
      <button
        type="button"
        aria-label="Copy error message"
        title="Copy error message"
        onClick={(event) => {
          event.stopPropagation();
          copyToClipboard(copyText ?? text).then((ok) => {
            if (ok) setCopied(true);
          });
        }}
        className="absolute right-2 top-0 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/toast:opacity-100"
      >
        {copied ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </button>
    </div>
  );
}

const ERROR_TOAST_DURATION_MS = 8000;

/**
 * Backstop for the one error whose fix is a specific screen.
 *
 * A pinned protocol version the server doesn't offer is dead-end text on its
 * own — the user cannot act on it without knowing where the setting lives. The
 * connect, reconnect and chat paths each attach their own action pointing at
 * the exact client that holds the pin, which is the better link. This exists
 * because "which toast fires" turned out to be a moving target: the same
 * failure surfaces from several call sites, and three separate ones shipped
 * without an action simply because nobody enumerated them.
 *
 * So: never override a caller's action, and where none was supplied fall back
 * to the clients list. Less precise than a per-site link, and still a way out.
 */
function protocolPinFallbackAction(
  message: unknown,
  data: Parameters<typeof sonnerToast.error>[1],
) {
  if (data?.action) return undefined;
  if (typeof message !== "string") return undefined;
  if (!isProtocolVersionPinFailure(undefined, message)) return undefined;
  return {
    action: {
      label: "Change protocol version",
      onClick: () => {
        track("change_protocol_version_clicked", {
          location: "toast_fallback",
          has_host_id: false,
        });
        navigateApp(routePaths.hosts);
      },
    },
  };
}

/**
 * Lift a `(ref …)` support reference out of the sentence and onto its own line.
 *
 * `convexErrMessage` splices the Convex request id into the message, because
 * most callers hand that string straight to a toast and a second argument
 * would be dropped on the way. Here — the one place every error toast passes
 * through — it becomes a `Reference <id>` description instead: a line the user
 * can screenshot, and one the existing hover copy button already picks up,
 * since `copyText` joins title and description. No new UI, no per-call-site
 * change, and no toast that reads as a stack trace.
 *
 * Like `protocolPinFallbackAction`, this never overrides what a caller passed:
 * a supplied description keeps its place and the reference follows it.
 */
function withSupportReference(
  message: string,
  data: Parameters<typeof sonnerToast.error>[1],
): { title: string; description: string | undefined } {
  const { text, requestId } = splitSupportReference(message);
  const description = data?.description;
  const callerText =
    typeof description === "string" && description.trim() !== ""
      ? description
      : undefined;
  if (!requestId) return { title: message, description: callerText };
  // Sonner also accepts a `ReactNode` or a render function here, and neither
  // can be concatenated with a line of text. Overwriting one would drop
  // whatever the caller chose to render, so the reference stays inline in the
  // sentence instead: less tidy, and nothing is lost either way.
  if (description != null && typeof description !== "string") {
    return { title: message, description: undefined };
  }
  const reference = `Reference ${requestId}`;
  return {
    title: text || message,
    description: callerText ? `${callerText}\n${reference}` : reference,
  };
}

const error: typeof sonnerToast.error = (message, data) => {
  const shaped =
    typeof message === "string" ? withSupportReference(message, data) : null;
  return sonnerToast.error(
    shaped ? (
      <CopyableErrorMessage
        text={shaped.title}
        // A toast that splits its failure across title and description has to
        // copy both, or the button hands over a server name and nothing else.
        // Blank descriptions are skipped: the delimiter would be all it added.
        copyText={
          shaped.description
            ? `${shaped.title}: ${shaped.description}`
            : undefined
        }
      />
    ) : (
      message
    ),
    {
      duration: ERROR_TOAST_DURATION_MS,
      ...data,
      ...(shaped?.description ? { description: shaped.description } : {}),
      ...protocolPinFallbackAction(message, data),
    },
  );
};

export const toast: typeof sonnerToast = Object.assign(
  (...args: Parameters<typeof sonnerToast>) => sonnerToast(...args),
  sonnerToast,
  { error },
);
