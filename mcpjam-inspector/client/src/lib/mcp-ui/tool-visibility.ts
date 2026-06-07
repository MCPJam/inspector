/**
 * SEP-1865 tool visibility helpers.
 *
 * Dependency-free leaf module so both the React renderer utilities
 * (`mcp-apps-utils.ts`, re-exported for back-compat) and the framework-free
 * host bridge (`host-app-bridge.ts`, consumed by the eval harness) share one
 * source of truth for the model-only visibility check without dragging
 * heavier dependencies into either consumer.
 */

/**
 * Get the visibility array from tool metadata.
 * Default: ["model", "app"] if not specified (per SEP-1865).
 */
export function getToolVisibility(
  toolMeta: Record<string, unknown> | undefined,
): Array<"model" | "app"> {
  const ui =
    toolMeta?.ui &&
    typeof toolMeta.ui === "object" &&
    !Array.isArray(toolMeta.ui)
      ? (toolMeta.ui as { visibility?: unknown })
      : undefined;
  const visibility = ui?.visibility;
  if (!Array.isArray(visibility)) return ["model", "app"];

  // Dedupe: a payload like `["model", "model"]` must not make
  // `isVisibleToModelOnly` (which checks `length === 1`) return false and
  // silently weaken the model-only block the shared bridge enforces.
  const normalized = Array.from(
    new Set(
      visibility.filter(
        (scope): scope is "model" | "app" =>
          scope === "model" || scope === "app",
      ),
    ),
  );
  return normalized.length > 0 ? normalized : ["model", "app"];
}

/**
 * Check if tool is visible to model only (not callable by apps).
 * True when visibility is exactly ["model"].
 */
export function isVisibleToModelOnly(
  toolMeta: Record<string, unknown> | undefined,
): boolean {
  const visibility = getToolVisibility(toolMeta);
  return visibility.length === 1 && visibility[0] === "model";
}

/**
 * Check if tool is visible to app only (hidden from model).
 * True when visibility is exactly ["app"].
 */
export function isVisibleToAppOnly(
  toolMeta: Record<string, unknown> | undefined,
): boolean {
  const visibility = getToolVisibility(toolMeta);
  return visibility.length === 1 && visibility[0] === "app";
}
