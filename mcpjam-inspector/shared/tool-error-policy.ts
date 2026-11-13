/**
 * Whether a tool call that returns an error fails an eval case.
 *
 * Stored per case as `advancedConfig.failOnToolError`, which the runner reads
 * and the case editor writes through these two functions. Only an explicit
 * `false` turns it off, so a case nobody has touched keeps failing on tool
 * errors, and turning it back on removes the key rather than storing `true`.
 */

/** True unless the case's `advancedConfig` says `failOnToolError: false`. */
export function failsOnToolError(
  advancedConfig: Record<string, unknown> | undefined,
): boolean {
  return advancedConfig?.failOnToolError !== false;
}

/**
 * `advancedConfig` with the setting applied. An object left with no keys
 * becomes `undefined`, the form the editor already saves for "nothing set".
 */
export function withFailOnToolError(
  advancedConfig: Record<string, unknown> | undefined,
  failOnToolError: boolean,
): Record<string, unknown> | undefined {
  const { failOnToolError: _previous, ...rest } = advancedConfig ?? {};
  const next = failOnToolError ? rest : { ...rest, failOnToolError: false };
  return Object.keys(next).length > 0 ? next : undefined;
}
