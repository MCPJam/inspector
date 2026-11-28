#!/usr/bin/env node
/**
 * The ESLint suppressions ratchet: fail when a change raises any count in an
 * `eslint-suppressions.json` above the base branch's, or adds a path or rule
 * the base did not suppress.
 *
 * ESLint reads the suppressions file from the change under test, so without
 * this check a PR could raise a count, or add an entry, and hide the error it
 * introduced. Lowering a count or removing an entry always passes.
 *
 *   node scripts/slop/eslint-suppressions.mjs sdk/eslint-suppressions.json
 *   node scripts/slop/eslint-suppressions.mjs FILE --base HEAD^1   # CI
 *
 * The default base is the merge-base with origin/main, as in ratchet.mjs.
 * SLOP_WAIVER=true reports the same result and exits 0; a file rename moves
 * its entries to a new path, which needs the waiver or the errors fixed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Each `{ path, rule, before, after }` whose count went up or is new. */
export function compare(base, current) {
  const increases = [];
  for (const [path, rules] of Object.entries(current)) {
    for (const [rule, { count }] of Object.entries(rules)) {
      const before = base[path]?.[rule]?.count ?? 0;
      if (count > before) increases.push({ path, rule, before, after: count });
    }
  }
  return increases;
}

/** The file at `base`, or undefined when the base does not have it. */
function readAtBase(base, file) {
  // A bad ref must fail the check, not read as a missing file.
  git(["rev-parse", "--verify", `${base}^{commit}`]);
  try {
    return JSON.parse(git(["show", `${base}:${file}`]));
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    return undefined;
  }
}

function check(file, base, waived) {
  const before = readAtBase(base, file);
  if (!before) {
    console.log(`${file} is not on ${base}; this change adds the baseline.`);
    return 0;
  }
  const after = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const increases = compare(before, after);
  if (!increases.length) {
    console.log(`${file}: no suppression count went up.`);
    return 0;
  }
  console.log(`${file}: suppressions went up against ${base}:`);
  for (const { path, rule, before: was, after: now } of increases) {
    console.log(`- ${path}: ${rule} ${was} -> ${now}`);
  }
  console.log(
    waived
      ? "Waived by the `slop-waiver` label."
      : "Fix the new errors instead of suppressing them. A CODEOWNER can apply `slop-waiver` with a reason.",
  );
  return waived ? 0 : 1;
}

// Compared as URLs: on Windows argv[1] is a `C:\` path, not a `file:` URL.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const argv = process.argv.slice(2);
    const baseIndex = argv.indexOf("--base");
    const base =
      baseIndex !== -1
        ? argv[baseIndex + 1]
        : git(["merge-base", "HEAD", "origin/main"]).trim();
    const files =
      baseIndex === -1
        ? argv
        : argv.filter(
            (_, index) => index !== baseIndex && index !== baseIndex + 1,
          );
    if (!base || !files.length) {
      throw new Error("usage: eslint-suppressions.mjs FILE... [--base REF]");
    }
    const waived = process.env.SLOP_WAIVER === "true";
    process.exitCode = Math.max(
      ...files.map((file) => check(file, base, waived)),
    );
  } catch (error) {
    // Exit 1 means a count went up; 2 means the check could not run.
    console.error(error.message);
    process.exitCode = 2;
  }
}
