/** Only automatic additions to an interactive ad-hoc chat may be omitted.
 * The request is omission intent; the resolved environment supplies membership. */
export function optionalAutomaticPluginServers(args: {
  requested: unknown;
  origin: string | undefined;
  mode: "interactive" | "recorded";
  pluginServerIds: readonly string[];
  selectedServerIds: readonly string[];
}): ReadonlySet<string> {
  if (
    args.mode !== "interactive" ||
    args.origin !== "adhoc" ||
    !Array.isArray(args.requested) ||
    args.requested.length > 100
  )
    return new Set();
  const plugins = new Set(args.pluginServerIds);
  const selected = new Set(args.selectedServerIds);
  return new Set(
    args.requested.filter(
      (id): id is string =>
        typeof id === "string" && plugins.has(id) && !selected.has(id),
    ),
  );
}
