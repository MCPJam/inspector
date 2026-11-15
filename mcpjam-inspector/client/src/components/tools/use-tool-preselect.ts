import { useEffect, useRef } from "react";
import { useCurrentLocationState } from "@/lib/app-navigation";

/** Navigation state that opens one tool's form when the Tools tab loads. */
export interface ToolPreselectState {
  preselectTool: string;
}

export function readPreselectTool(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const name = (state as Partial<ToolPreselectState>).preselectTool;
  return typeof name === "string" && name ? name : null;
}

/**
 * Select the tool named in the navigation state once the list contains it.
 * It applies once per navigation, so going back to the list stays there.
 */
export function useToolPreselect({
  tools,
  selectedTool,
  onSelectTool,
}: {
  tools: Record<string, unknown>;
  selectedTool: string;
  onSelectTool: (name: string) => void;
}): void {
  const target = readPreselectTool(useCurrentLocationState());
  const appliedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!target || appliedRef.current === target) return;
    if (!Object.hasOwn(tools, target)) return;
    appliedRef.current = target;
    if (selectedTool !== target) onSelectTool(target);
  }, [target, tools, selectedTool, onSelectTool]);
}
