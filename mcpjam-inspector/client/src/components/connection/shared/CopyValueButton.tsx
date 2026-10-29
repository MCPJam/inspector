import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";

interface CopyValueButtonProps {
  value: string;
  /** What is copied, e.g. "X-API-Key". Reads as "Copy value for X-API-Key". */
  subject: string;
}

/** Copies one value. Sized and styled like the editors' row remove button, so
 * it can sit in that slot on a read-only row. */
export function CopyValueButton({ value, subject }: CopyValueButtonProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timeout);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyToClipboard(value)) {
          setCopied(true);
        } else {
          toast.error(
            `Could not copy the value for ${subject}. Show it and copy it from the field.`,
          );
        }
      }}
      aria-label={`Copy value for ${subject}`}
      title={`Copy value for ${subject}`}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
