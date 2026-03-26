/**
 * Group key for machine-generated cases like `suite-get_task-iter-1` / `iter-2`.
 */
export function getEvalCaseSidebarGroupKey(title: string): string {
  const t = title.trim() || "—";
  const m = t.match(/^(.*)-iter-(\d+)$/i);
  if (m?.[1]) {
    return m[1].replace(/\s+$/, "");
  }
  return t;
}

/**
 * Two-line labels for narrow sidebars: emphasize the varying suffix (e.g. iter-2).
 */
export function formatCaseTitleForSidebar(title: string): {
  line1: string;
  line2: string | null;
  fullTitle: string;
} {
  const fullTitle = title.trim() || "Untitled test case";
  const m = fullTitle.match(/^(.*)-iter-(\d+)$/i);
  if (m?.[1] != null && m[2] != null) {
    const base = m[1].replace(/\s+$/, "");
    const line1 = `iter-${m[2]}`;
    return {
      line1,
      line2: base.length > 0 ? base : null,
      fullTitle,
    };
  }
  if (fullTitle.length > 44) {
    return {
      line1: `…${fullTitle.slice(-40)}`,
      line2: fullTitle.slice(0, fullTitle.length - 40),
      fullTitle,
    };
  }
  return { line1: fullTitle, line2: null, fullTitle };
}

export function groupEvalCasesForSidebar<T extends { title?: string; _id: string }>(
  cases: T[],
): { groupKey: string; cases: T[] }[] {
  const map = new Map<string, T[]>();
  for (const c of cases) {
    const k = getEvalCaseSidebarGroupKey(c.title || "");
    const arr = map.get(k);
    if (arr) arr.push(c);
    else map.set(k, [c]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([groupKey, groupCases]) => ({
      groupKey,
      cases: groupCases.sort((x, y) =>
        (x.title || "").localeCompare(y.title || ""),
      ),
    }));
}
