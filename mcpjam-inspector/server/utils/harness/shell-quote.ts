/**
 * POSIX single-quote a shell argument (defense-in-depth). Values reaching the
 * sandbox `run` are cloud-managed and/or validated (skill-name charset,
 * `isPathWithinDirectory`), but neither containment nor a name validator
 * neutralizes spaces / `;` / `$()` on its own — so every interpolation into a
 * `find` / `rm` / `ls` command quotes first: a managed filename must never be
 * able to break out of its argument.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
