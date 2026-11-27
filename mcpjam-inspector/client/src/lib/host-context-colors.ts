import type { ProjectHostContextDraft } from "@/lib/client-config";

/** Let the selected theme's preset replace colors captured for another theme. */
export function withoutThemeBoundColors(
  hostContext: ProjectHostContextDraft,
): ProjectHostContextDraft {
  const styles = hostContext.styles;
  if (!styles || typeof styles !== "object" || Array.isArray(styles)) {
    return hostContext;
  }
  if (!("variables" in styles)) return hostContext;
  const variables = styles.variables;
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    return hostContext;
  }

  return {
    ...hostContext,
    styles: {
      ...styles,
      variables: Object.fromEntries(
        Object.entries(variables).filter(
          ([key, value]) =>
            !key.startsWith("--color-") ||
            (typeof value === "string" && value.includes("light-dark(")),
        ),
      ),
    },
  };
}
