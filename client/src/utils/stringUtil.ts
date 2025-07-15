/**
 * Shortens a string to a maximum length, adding "..." if it exceeds the length.
 *
 * @param str - The string to shorten.
 * @param maxLength - The maximum length of the string. Defaults to 40.
 * @returns The shortened string.
 */

export default class StringUtil {
  static shorten(str: string, maxLength: number = 30): string {
    return str.length > maxLength
      ? str.substring(0, maxLength - 3) + "..."
      : str;
  }
}
