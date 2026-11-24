import { useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";

/**
 * Copies `text`. The label changes to "Copied" only when the clipboard took it;
 * a refused write says so, so a person does not paste something stale.
 */
export function CopyButton({
  text,
  label = "Copy",
  size = "sm",
}: {
  text: string;
  label?: string;
  size?: "sm" | "default";
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <Button size={size} variant="outline" onClick={() => void copy()}>
      <Copy aria-hidden />
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Select the text and copy it"
          : label}
    </Button>
  );
}
