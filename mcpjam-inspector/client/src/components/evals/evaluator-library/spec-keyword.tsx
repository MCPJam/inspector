import { cn } from "@/lib/utils";

/** RFC 2119 keywords as the MCP specification writes them. */
export type SpecKeywordValue = "MUST" | "MUST NOT" | "SHOULD" | "MAY";

/**
 * The keyword from the MCP spec that a server check tests. MUST and MUST NOT
 * share the destructive tint because breaking either is a spec violation;
 * SHOULD is a warning; MAY is neutral.
 */
export function SpecKeyword({ keyword }: { keyword: SpecKeywordValue }) {
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[11px] font-semibold",
        (keyword === "MUST" || keyword === "MUST NOT") &&
          "bg-destructive/10 text-destructive",
        keyword === "SHOULD" && "bg-warning/15 text-foreground",
        keyword === "MAY" && "bg-muted text-muted-foreground",
      )}
    >
      {keyword}
    </span>
  );
}
