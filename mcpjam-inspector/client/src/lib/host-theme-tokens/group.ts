export const TOKEN_CATEGORIES = [
  "background",
  "text",
  "border",
  "ring",
  "typography",
  "radius",
  "shadow",
  "other",
] as const;

export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

export const TOKEN_CATEGORY_LABELS: Record<TokenCategory, string> = {
  background: "background",
  text: "text",
  border: "border",
  ring: "ring",
  typography: "type",
  radius: "radius",
  shadow: "shadow",
  other: "other",
};

export function categoryForToken(name: string): TokenCategory {
  if (name.startsWith("--color-background-")) return "background";
  if (name.startsWith("--color-text-")) return "text";
  if (name.startsWith("--color-border-")) return "border";
  if (name.startsWith("--color-ring-")) return "ring";
  if (name.startsWith("--font-")) return "typography";
  if (name.startsWith("--border-radius-") || name.startsWith("--border-width-")) {
    return "radius";
  }
  if (name.startsWith("--shadow-")) return "shadow";
  return "other";
}

export interface GroupedToken {
  name: string;
  value: string;
  category: TokenCategory;
}

export function groupStyleVariables(
  variables: Record<string, string>,
): Array<{ category: TokenCategory; tokens: GroupedToken[] }> {
  const buckets = new Map<TokenCategory, GroupedToken[]>();
  for (const category of TOKEN_CATEGORIES) {
    buckets.set(category, []);
  }
  for (const [name, value] of Object.entries(variables)) {
    const category = categoryForToken(name);
    buckets.get(category)?.push({ name, value, category });
  }
  return TOKEN_CATEGORIES.filter((category) => {
    return (buckets.get(category)?.length ?? 0) > 0;
  }).map((category) => ({
    category,
    tokens: buckets.get(category) ?? [],
  }));
}
