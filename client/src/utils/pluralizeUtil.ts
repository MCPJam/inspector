import pluralize from "pluralize";

/**
 * Returns a pluralized phrase like "1 server" or "2 servers"
 *
 * @param count - The quantity
 * @param word - The singular form of the noun
 * @returns A formatted pluralized string
 */
export function formatPlural(count: number, word: string): string {
  return `${count} ${pluralize(word, count)}`;
}
