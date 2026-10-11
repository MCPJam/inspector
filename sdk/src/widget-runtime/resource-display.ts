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
