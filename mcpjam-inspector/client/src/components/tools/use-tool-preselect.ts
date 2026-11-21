import { useState } from "react";
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
 * It applies once per navigation, so going back to the list stays there, and
 * a tool the user already picked wins. The selection is adjusted while
 * rendering, from the list and the navigation state, not in an effect.
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
  // The navigation target still waiting for the list; null once handled.
  const [pending, setPending] = useState(target);
  const [seenTarget, setSeenTarget] = useState(target);

  if (target !== seenTarget) {
    setSeenTarget(target);
    setPending(target);
    return;
  }
  if (!pending) return;
  if (selectedTool && selectedTool !== pending) {
    setPending(null);
    return;
  }
  if (!Object.hasOwn(tools, pending)) return;
  setPending(null);
  if (selectedTool !== pending) onSelectTool(pending);
}
