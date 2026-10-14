/** OpenAI resource display hints, separate from a host's actual capabilities. */
export type ResourceDisplayMode = "inline" | "fullscreen";
export interface ResourceDisplayHints {
  preferredDisplayMode?: ResourceDisplayMode;
  availableDisplayModes?: ResourceDisplayMode[];
}
const isMode = (value: unknown): value is ResourceDisplayMode =>
  value === "inline" || value === "fullscreen";

/** Content metadata wins as one group. Malformed content never falls through. */
export function readResourceDisplayHints(
  contentMeta?: Record<string, unknown>,
  listingMeta?: Record<string, unknown>
): ResourceDisplayHints | undefined {
  const source = Object.hasOwn(contentMeta ?? {}, "openai/ui")
    ? contentMeta
    : listingMeta;
  if (!Object.hasOwn(source ?? {}, "openai/ui")) return undefined;
  const value = source?.["openai/ui"];
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid resource display metadata");
  const record = value as Record<string, unknown>;
  const preferred = record.preferredDisplayMode;
  const available = record.availableDisplayModes;
  if (preferred !== undefined && !isMode(preferred))
    throw new Error("Invalid preferred display mode");
  if (
    available !== undefined &&
    (!Array.isArray(available) ||
      available.length < 1 ||
      available.length > 2 ||
      !available.every(isMode) ||
      new Set(available).size !== available.length)
  )
    throw new Error("Invalid available display modes");
  if (preferred === undefined && available === undefined) return undefined;
  return {
    ...(preferred !== undefined ? { preferredDisplayMode: preferred } : {}),
    ...(available !== undefined
      ? { availableDisplayModes: [...(available as ResourceDisplayMode[])] }
      : {}),
  };
}

/** Resource declarations narrow the host before init; App declarations after it. */
export function negotiateResourceDisplayModes<T extends string>(
  hostModes: readonly T[],
  hints?: ResourceDisplayHints,
  appModes?: readonly string[]
): T[] {
  const resourceModes =
    hints?.availableDisplayModes ??
    (hints?.preferredDisplayMode ? [hints.preferredDisplayMode] : undefined);
  return hostModes.filter(
    (mode) =>
      (!resourceModes || resourceModes.includes(mode as ResourceDisplayMode)) &&
      (appModes === undefined || appModes.includes(mode))
  );
}

/**
 * OpenAI's display-mode rules, used for ChatGPT and Codex clients with the
 * Display modes extension on. Unlike {@link negotiateResourceDisplayModes}:
 * omitted resource modes mean every host mode, and `preferredDisplayMode`
 * only picks the starting mode, never narrows the set.
 *
 * `fixed` is an entrypoint's host-chosen mode. It ignores the resource's
 * declaration (an entrypoint resource may declare only `inline` and still
 * opens fullscreen in ChatGPT), but an App that declares at initialization
 * that it cannot show the fixed mode is refused rather than forced into it.
 */
export function openAIDisplayModes<T extends string>(
  hostModes: readonly T[],
  hints?: ResourceDisplayHints,
  appModes?: readonly string[],
  fixed?: T
): T[] {
  const appAllows = (mode: T) =>
    appModes === undefined || appModes.includes(mode);
  if (fixed !== undefined)
    return hostModes.includes(fixed) && appAllows(fixed) ? [fixed] : [];
  const resourceModes = hints?.availableDisplayModes;
  return hostModes.filter(
    (mode) =>
      (!resourceModes || resourceModes.includes(mode as ResourceDisplayMode)) &&
      appAllows(mode)
  );
}

/**
 * The mode an App starts in, always a member of `allowed`: the resource's
 * preference; else fullscreen when the resource declared both inline and
 * fullscreen, otherwise inline; else the first allowed mode in host order.
 */
export function pickOpenAIDisplayMode<T extends string>(
  allowed: readonly T[],
  hints?: ResourceDisplayHints
): T | undefined {
  const declared = hints?.availableDisplayModes;
  const fallback: ResourceDisplayMode =
    declared?.includes("inline") && declared.includes("fullscreen")
      ? "fullscreen"
      : "inline";
  for (const mode of [hints?.preferredDisplayMode, fallback]) {
    const match = allowed.find((candidate) => candidate === mode);
    if (match !== undefined) return match;
  }
  return allowed[0];
}
