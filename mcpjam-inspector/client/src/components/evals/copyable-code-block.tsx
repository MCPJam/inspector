import { useCallback, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

interface CopyableCodeBlockProps {
  code: string;
  copyLabel: string;
  className?: string;
  toolbarLabel?: string;
  actions?: ReactNode;
  onCopySuccess?: () => void;
}

export function CopyableCodeBlock({
  code,
  copyLabel,
  className,
  toolbarLabel,
  actions,
  onCopySuccess,
}: CopyableCodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(code);
    if (ok) {
      toast.success("Copied to clipboard");
      onCopySuccess?.();
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error("Could not copy");
    }
  }, [code, onCopySuccess]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-muted/30",
        className,
      )}
    >
      {toolbarLabel ? (
        <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/50 px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {toolbarLabel}
          </span>
          <div className="flex items-center gap-1">
            {actions}
            <button
              type="button"
              onClick={handleCopy}
              aria-label={copyLabel}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-600 dark:text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      ) : null}
      <div className="relative">
        <pre
          className={cn(
            "max-h-[min(420px,55vh)] overflow-auto px-4 py-3.5 text-left font-mono text-[11px] leading-relaxed text-foreground sm:text-xs",
            toolbarLabel ? "pr-4" : "pr-12",
          )}
          tabIndex={0}
        >
          <code>{code}</code>
        </pre>
        {!toolbarLabel ? (
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copyLabel}
            className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {copied ? (
              <Check className="h-4 w-4 text-green-600 dark:text-green-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}
