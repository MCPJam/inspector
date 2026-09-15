/** Local preference never changes the hosted tool list or unattended policy. */
export function resolveLocalBrowserTools(
  toolIds: string[] | undefined,
  localBrowserEnabled: boolean | undefined,
  localInteractive: boolean,
): string[] | undefined {
  if (!localInteractive || localBrowserEnabled === undefined) return toolIds;
  const others = (toolIds ?? []).filter((id) => id !== "browser");
  return localBrowserEnabled ? [...others, "browser"] : others;
}
