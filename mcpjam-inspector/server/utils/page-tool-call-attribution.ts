import type { ToolSet } from "ai";
import { mergePageToolAttributionMetadata } from "@/shared/mcp-tool-origin-metadata";

// Capture the registration advertised for this turn. Never resolve historical
// calls against the page's current registry.
const attribution = new WeakMap<object, { rawName: string; origin: string }>();

export function registerPageToolAttribution(
  tool: ToolSet[string],
  entry: { rawName: string; origin: string },
): void {
  attribution.set(tool, { rawName: entry.rawName, origin: entry.origin });
}

export function withPageToolAttributionMetadata(
  metadata: unknown,
  tool: ToolSet[string] | undefined,
) {
  return mergePageToolAttributionMetadata(
    metadata,
    tool ? attribution.get(tool) : undefined,
  );
}
