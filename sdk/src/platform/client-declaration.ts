/**
 * The client a `PlatformApiClient` declares on every request, for usage
 * analytics. It carries the same JSON as `x-mcpjam-launcher`, which is sent
 * only on launches because routes store it on what a launch creates; this
 * header is never stored or used to decide anything.
 */
export const CLIENT_DECLARATION_HEADER = "x-mcpjam-client";

/**
 * `JSON.stringify` with every character outside printable ASCII escaped.
 * `Headers` rejects a value with any code unit above U+00FF, so a launcher
 * named in another script would otherwise fail every request; `JSON.parse`
 * on the server restores the original text.
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/** The declaration header for a client whose launcher header is `launcher`. */
export function clientDeclarationHeaders(
  launcher: string | undefined
): Record<string, string> | undefined {
  return launcher ? { [CLIENT_DECLARATION_HEADER]: launcher } : undefined;
}
