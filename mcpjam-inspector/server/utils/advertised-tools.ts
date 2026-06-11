/**
 * advertised-tools.ts — runtime-conditional advertised-tool narrowing.
 *
 * Browser-rendered MCP App eval PR 2. Both engine paths — the hosted-path
 * `runChatEngineLoop` (`mcpjam-stream-handler.ts`) and the local AI-SDK path
 * `runDirectChatTurn` (`direct-chat-turn.ts`) — delegate the per-step
 * advertised-tool decision here so the contract (and its edge cases) has one
 * source of truth and one test surface.
 *
 * This is distinct from progressive tool discovery (lazy MCP tool catalogs):
 * progressive discovery decides which tools are *loaded*, while this hook
 * decides which of the already-active tools are *advertised this step* based on
 * caller-owned runtime state (e.g. hide `computer` / `finish_widget` until an
 * MCP App widget has actually rendered in the harness).
 */

/**
 * Per-step advertised-tool narrowing hook. Receives the names that would
 * otherwise be advertised this step and returns the subset to keep, or
 * `undefined` for "no narrowing".
 */
export type PrepareAdvertisedTools = (ctx: {
  stepIndex: number;
  defaultToolNames: string[];
}) => string[] | undefined;

/**
 * Resolve the advertised tool-name list for a step.
 *
 * Contract:
 *   - no hook                         → `defaultToolNames` unchanged
 *   - hook returns `undefined`        → `defaultToolNames` unchanged
 *   - hook returns a name list        → `defaultToolNames ∩ list` (preserving
 *                                        `defaultToolNames` order); any name not
 *                                        already advertised is dropped
 *                                        (defense-in-depth: a hook can't smuggle
 *                                        in a non-advertised tool)
 *   - hook throws                     → logged via `onWarn`, falls back to
 *                                        `defaultToolNames` (a buggy hook can't
 *                                        crash the loop)
 */
export function applyPrepareAdvertisedTools(params: {
  defaultToolNames: string[];
  stepIndex: number;
  prepareAdvertisedTools?: PrepareAdvertisedTools;
  onWarn?: (message: string, meta: { error: string }) => void;
}): string[] {
  const { defaultToolNames, stepIndex, prepareAdvertisedTools, onWarn } =
    params;
  if (!prepareAdvertisedTools) return defaultToolNames;

  let narrowed: string[] | undefined;
  try {
    narrowed = prepareAdvertisedTools({ stepIndex, defaultToolNames });
  } catch (err) {
    onWarn?.("prepareAdvertisedTools threw; advertising default tool set", {
      error: err instanceof Error ? err.message : String(err),
    });
    return defaultToolNames;
  }

  if (narrowed === undefined) return defaultToolNames;
  const keep = new Set(narrowed);
  return defaultToolNames.filter((name) => keep.has(name));
}

/**
 * Execution gate for the advertised subset (advertise = ENFORCE).
 *
 * `prepareAdvertisedTools` narrows what the model is *shown*, but the executable
 * tool map still contains the hidden tools, so a hallucinated / remembered call
 * to a hidden tool (e.g. `computer` before a widget renders) would otherwise
 * still run. This wraps each tool's `execute` to throw a recoverable error when
 * the tool isn't in the step's advertised set — the AI SDK (and the hosted
 * `executeToolCallsFromMessages` path) surface the throw as a tool-error result
 * the model can recover from, exactly like `gateToolsToActiveSubset` does for
 * progressive discovery.
 *
 * `getAdvertised()` returns the current step's advertised names, or `null` for
 * "no narrowing" (all tools executable — the gate is a no-op). Read at execute
 * time so per-step changes are honored.
 */
export function gateToolsToAdvertisedSubset<
  T extends Record<string, unknown>,
>(tools: T, getAdvertised: () => ReadonlySet<string> | null): T {
  const result: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(tools)) {
    const original = def as Record<string, unknown>;
    const execute = original.execute as
      | ((input: unknown, ctx: unknown) => unknown)
      | undefined;
    if (typeof execute !== "function") {
      result[name] = original;
      continue;
    }
    result[name] = {
      ...original,
      execute: async (input: unknown, ctx: unknown) => {
        const advertised = getAdvertised();
        if (advertised && !advertised.has(name)) {
          throw new Error(
            `Tool '${name}' is not available in this step (not advertised to the model).`,
          );
        }
        return execute(input, ctx);
      },
    };
  }
  return result as T;
}

