import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import { cn } from "@/lib/utils";

interface JsonEditorViewProps {
  value: unknown;
  className?: string;
}

export function JsonEditorView({ value, className }: JsonEditorViewProps) {
  // Handle primitive and null values
  const displayValue =
    value === null || value === undefined
      ? {}
      : typeof value === "object"
        ? value
        : { value };

  return (
    <div className={cn("p-4", className)}>
      <JsonView
        src={displayValue as object}
        dark={true}
        theme="atom"
        enableClipboard={true}
        displaySize={false}
        collapseStringsAfterLength={100}
        style={{
          fontSize: "12px",
          fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
          backgroundColor: "transparent",
          padding: "0",
        }}
      />
    </div>
  );
}
