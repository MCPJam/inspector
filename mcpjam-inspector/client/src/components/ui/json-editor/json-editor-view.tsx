import { useTheme } from "next-themes";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import { cn } from "@/lib/utils";

interface JsonEditorViewProps {
  value: unknown;
  className?: string;
}

export function JsonEditorView({ value, className }: JsonEditorViewProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  // Handle primitive and null values
  const displayValue =
    value === null || value === undefined
      ? {}
      : typeof value === "object"
        ? value
        : { value };

  return (
    <div className={cn("p-4 text-xs", className)} style={{ fontFamily: "var(--font-code)" }}>
      <JsonView
        src={displayValue as object}
        dark={isDark}
        theme="atom"
        enableClipboard={true}
        displaySize={false}
        collapseStringsAfterLength={100}
        style={{
          backgroundColor: "transparent",
          padding: "0",
        }}
      />
    </div>
  );
}
