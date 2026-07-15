import { useEffect, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";

interface JsonEditorCopyOverlayProps {
  /**
   * Performs the copy. Returning `false` (or throwing) suppresses the "copied"
   * feedback — e.g. when the underlying clipboard write fails.
   */
  onCopy: () => boolean | void | Promise<boolean | void>;
  className?: string;
}

/**
 * Floating "copy the whole payload" affordance for the JSON editor.
 *
 * The editor's toolbar already exposes a copy button, but a large share of the
 * product renders the editor *without* a toolbar (viewOnly surfaces, or
 * `showToolbar={false}` — logs, tool results, eval traces, resources, …). On
 * those surfaces the only way to copy was the tiny per-value glyph buried in the
 * tree view, which most users never discover. This overlay gives every one of
 * those editors a single discoverable copy action.
 *
 * Reveal behaviour mirrors the rest of the product's row-action pattern: the
 * button is invisible until the editor is hovered or keyboard-focused (its
 * parent must carry the `group` class), and it stays visible for a beat after a
 * copy so the ✓ confirmation is readable.
 */
export function JsonEditorCopyOverlay({
  onCopy,
  className,
}: JsonEditorCopyOverlayProps) {
  const [copied, setCopied] = useState(false);
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
      }
    };
  }, []);

  const handleClick = async (e: React.MouseEvent) => {
    // Never let the copy click bubble into the surrounding surface (e.g. a log
    // row that toggles expansion on click).
    e.stopPropagation();

    let result: boolean | void;
    try {
      result = await onCopy();
    } catch {
      return;
    }
    if (result === false) {
      return;
    }

    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current);
    }
    setCopied(true);
    resetTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={handleClick}
      title={copied ? "Copied!" : "Copy to clipboard"}
      aria-label={copied ? "Copied to clipboard" : "Copy to clipboard"}
      className={cn(
        "absolute right-2 top-2 z-10 h-7 w-7 p-0",
        "border border-border/50 bg-background/80 shadow-sm backdrop-blur-sm",
        "transition-all duration-150 hover:scale-105",
        // Space is reserved by absolute positioning (no layout shift); the
        // button fades in on editor hover/focus and stays put right after copy.
        "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        copied && "bg-success/10 opacity-100",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}
