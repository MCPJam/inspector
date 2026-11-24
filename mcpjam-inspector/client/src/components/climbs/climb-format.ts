/** Words and numbers the climb screens share. */

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** Whole numbers typed with or without commas; anything else is not a number. */
export function parseWhole(text: string): number | null {
  const cleaned = text.trim().replace(/,/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}
