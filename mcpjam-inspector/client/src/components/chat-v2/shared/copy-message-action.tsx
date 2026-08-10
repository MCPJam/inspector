import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";

import { copyToClipboard } from "@/lib/clipboard";

type CopyMessageActionProps = {
  /** The message's plain text, resolved lazily so hover renders stay cheap. */
  getText: () => string;
};

/**
 * Per-message action that copies the message's text to the clipboard. Works on
 * both user prompts and assistant responses; like `EditMessageAction` it needs
 * no auth or session, so it renders on any transcript.
 */
export function CopyMessageAction({ getText }: CopyMessageActionProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );

  const handleCopy = async () => {
    const ok = await copyToClipboard(getText());
    if (!ok) return;
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0">
          <button
            type="button"
            aria-label="Copy message"
            className="flex size-6 shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy message"}</TooltipContent>
    </Tooltip>
  );
}
