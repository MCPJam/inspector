const PATTERN_CHARACTERS = /[*?[\]]/;

/**
 * Why a tool name typed into an assertion can never be graded as called.
 *
 * Matchers compare `toolName` with strict equality, so a pattern such as
 * `search*` is a literal name no server advertises, and the assertion fails
 * as "never called" on every trial. The warning is advisory: a name absent
 * from `knownTools` may belong to a server whose catalogue has not loaded.
 */
export function toolNameWarning(
  name: string,
  knownTools?: readonly string[],
): string | undefined {
  if (!name.trim()) return undefined;
  if (PATTERN_CHARACTERS.test(name))
    return "Tool names match exactly. Wildcards such as * are not supported.";
  // Untrimmed on purpose: grading compares the raw string, so `search ` is
  // not `search`.
  if (knownTools?.length && !knownTools.includes(name))
    return `No loaded tool is named "${name}".`;
  return undefined;
}
