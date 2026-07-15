import { useEffect, useState } from "react";
import { toast as sonnerToast } from "sonner";
import { Check, Copy } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";

/**
 * App-wide toast.
 *
 * Identical to Sonner's `toast`, except error toasts persist until the user
 * dismisses them (the global `<Toaster>` enables a close button) instead of
 * auto-dismissing on Sonner's ~4s default. Errors are the one toast type users
 * must read and usually act on, so they shouldn't vanish on a timer the way
 * success/info toasts do.
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
function CopyableErrorMessage({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="relative pr-7">
      <span className="whitespace-pre-wrap break-words">{text}</span>
      <button
        type="button"
        aria-label="Copy error message"
        title="Copy error message"
        onClick={(event) => {
          event.stopPropagation();
          copyToClipboard(text).then((ok) => {
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

const error: typeof sonnerToast.error = (message, data) =>
  sonnerToast.error(
    typeof message === "string" ? <CopyableErrorMessage text={message} /> : message,
    { duration: Infinity, ...data },
  );

export const toast: typeof sonnerToast = Object.assign(
  (...args: Parameters<typeof sonnerToast>) => sonnerToast(...args),
  sonnerToast,
  { error }
);
