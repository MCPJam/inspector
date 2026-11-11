import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";

interface CopyValueButtonProps {
  value: string;
  /** What is copied, e.g. "value for X-API-Key" or "Access Token". Reads as
   * "Copy value for X-API-Key". */
  subject: string;
  /** "slot" fills the editors' 8x8 row remove-button slot; "inline" sits in a
   * token row's text, beside its eye. */
  size?: "slot" | "inline";
}

const SIZE_CLASSES = {
  slot: {
    button:
      "flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
    icon: "h-3.5 w-3.5",
  },
  inline: {
    button:
      "mt-0.5 flex-shrink-0 cursor-pointer p-1 text-muted-foreground/50 transition-colors hover:text-foreground",
    icon: "h-3 w-3",
  },
} as const;

/** Copies one value: a header row's or a token's. */
export function CopyValueButton({
  value,
  subject,
  size = "slot",
}: CopyValueButtonProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timeout);
  }, [copied]);

  const classes = SIZE_CLASSES[size];
  return (
    <button
      type="button"
      onClick={async (event) => {
        // A token row expands when clicked; copying it shouldn't.
        event.stopPropagation();
        if (await copyToClipboard(value)) {
          setCopied(true);
        } else {
          toast.error(
            `Could not copy the ${subject}. Show it and copy it by hand.`,
          );
        }
      }}
      aria-label={`Copy ${subject}`}
      title={`Copy ${subject}`}
      className={classes.button}
    >
      {copied ? (
        <Check className={`${classes.icon} text-success`} />
      ) : (
        <Copy className={classes.icon} />
      )}
    </button>
  );
}
