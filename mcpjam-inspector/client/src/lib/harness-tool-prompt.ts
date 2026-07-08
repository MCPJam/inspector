/**
 * Build the structured prompt that asks a harness agent (e.g. Claude Code) to
 * invoke one of its native built-in tools with specific arguments.
 *
 * The harness exposes NO API to fire a tool call directly — its only turn input
 * is a user message — so "Ask agent to run" sends an explicit, deterministic
 * instruction naming the tool + its exact input. Claude Code under
 * bypass-permissions reliably complies with "use the X tool with this input".
 *
 * Pure + deterministic so it can be unit-tested in isolation (the robustness of
 * the whole feature lives here).
 */
export function buildHarnessToolPrompt(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined);
  if (entries.length === 0) {
    return (
      `Use the ${toolName} tool. Call it exactly once with no arguments, ` +
      `then report the result.`
    );
  }
  const json = JSON.stringify(Object.fromEntries(entries), null, 2);
  return (
    `Use the ${toolName} tool. Call it exactly once with this input, then ` +
    `report the result:\n\n${json}`
  );
}
