import { Button } from "@mcpjam/design-system/button";

export function ReviewedErrorSummary({
  explanation,
  onCopy,
  copyState,
}: {
  explanation: string;
  onCopy: () => void;
  copyState: "idle" | "copied" | "failed";
}) {
  return (
    <div className="mt-2 space-y-2">
      <p className="leading-relaxed text-foreground">{explanation}</p>
      <Button type="button" variant="ghost" size="sm" onClick={onCopy}>
        {copyState === "copied"
          ? "Copied details"
          : copyState === "failed"
            ? "Couldn't copy details. Try again."
            : "Copy details"}
      </Button>
    </div>
  );
}
