#!/usr/bin/env node
/**
 * Dialog width-override guard (PUR-46).
 *
 * `DialogContent`, `AlertDialogContent` and `SheetContent` each bake a
 * responsive width cap into their base className — `sm:max-w-lg` (512px) for
 * the two dialogs, `sm:max-w-sm` (384px) for a left/right sheet. Callers
 * override it through `className`, which the component merges with
 * `cn` = `twMerge(clsx(...))`.
 *
 * tailwind-merge only collapses classes that share a variant. So an
 * UNPREFIXED `max-w-2xl` never registers as a conflict with `sm:max-w-lg`:
 * both survive into the output, and because Tailwind emits responsive rules
 * after base ones, the `sm:` cap wins on every viewport >= 640px. The
 * caller's class is dead code, and the dialog silently renders at the base
 * width instead of the declared one.
 *
 * The same mistake also deletes a guard. An unprefixed `max-w-*` DOES
 * conflict with the base `max-w-[calc(100%-2rem)]` (same utility, same
 * variant), so tailwind-merge drops that — and it is what keeps the dialog
 * off both screen edges below 640px.
 *
 * An audit in Aug 2026 found 18 dialogs in this state: 10 rendering narrower
 * than declared (worst: `ClientContextDialog` asked for 960px and got 512),
 * and 8 rendering wider. None of it was catchable by a test, because jsdom
 * computes no layout and every measured width is 0 — a width assertion passes
 * with the bug in place. The class name, however, is checkable statically.
 * That is what this script does.
 *
 * Fix for a violation: prefix the override (`sm:max-w-2xl`), or delete it if
 * the base cap is genuinely what you want.
 *
 * NOT a violation: an unprefixed `max-w-*` alongside an `sm:max-w-*` in the
 * same tag. That is the deliberate two-breakpoint form — the unprefixed class
 * intentionally replaces the base `max-w-[calc(100%-2rem)]` below 640px while
 * the prefixed one governs above it. `eval-runner`, `CiEvalsTab`,
 * `attachment-editor`, `HostFocusDialog` and `file-attachment-card` all use
 * it correctly. The guard only fires when NO `sm:max-w-*` is present, which
 * is the case where the caller's intent silently loses.
 *
 * Known blind spot: a className assembled from an imported constant is opaque
 * here. This catches the literal form, which is how all 89 current call sites
 * are written.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ROOTS = [
  "mcpjam-inspector/client/src",
  "design-system/src",
  "chat-ui/src",
];

const TAGS = ["DialogContent", "AlertDialogContent", "SheetContent"];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".vite"]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // A root that does not exist in this checkout is not a failure.
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/**
 * Return the source of a JSX opening tag, starting just after the tag name,
 * with comments stripped out.
 *
 * Comments must go, not merely be stepped over: the explanatory comment this
 * guard asks people to read quotes class names like `max-w-2xl` as prose, and
 * leaving that text in would make the guard report its own documentation.
 * Skipping them also stops a `>` inside a comment or string ending the tag
 * early — several of these tags contain `>= 640px`. Braces and parens are
 * counted so an arrow function in a prop (`onOpenChange={(o) => ...}`) is
 * likewise safe.
 *
 * Returns null when no terminator is found, which the caller treats as a hard
 * error rather than a skip: a tag this script cannot read is a tag it cannot
 * vouch for.
 */
function readOpeningTag(src, from) {
  let depth = 0;
  let out = "";
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      if (nl === -1) return null;
      i = nl;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 1;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        j++;
      }
      if (j >= src.length) return null;
      out += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "{" || c === "(") depth++;
    else if (c === "}" || c === ")") depth--;
    else if (c === ">" && depth === 0) return out;
    out += c;
  }
  return null;
}

// A `max-w-*` utility with any leading variant chain (`sm:`, `lg:`,
// `dark:sm:`, ...). Arbitrary values (`max-w-[60rem]`) are matched whole so a
// `:` inside the brackets is not mistaken for a variant separator.
const MAX_W = /(?:^|[\s"'`])((?:[a-z0-9.-]+:)*max-w-(?:\[[^\]]*\]|[\w./-]+))/g;

const violations = [];
const unparsed = [];

for (const root of ROOTS) {
  for (const file of walk(join(REPO, root))) {
    const src = readFileSync(file, "utf8");
    const rel = relative(REPO, file).replace(/\\/g, "/");

    for (const tag of TAGS) {
      const re = new RegExp(`<${tag}(?![A-Za-z0-9_])`, "g");
      let m;
      while ((m = re.exec(src))) {
        const start = m.index + tag.length + 1;
        const tagSrc = readOpeningTag(src, start);
        const line = src.slice(0, m.index).split("\n").length;

        if (tagSrc === null) {
          unparsed.push(`${rel}:${line}  <${tag}>`);
          continue;
        }

        const tokens = [...tagSrc.matchAll(MAX_W)].map((hit) => hit[1]);
        // An `sm:` override anywhere in the tag means the caller has taken
        // control of the breakpoint the base cap lives at. Any unprefixed
        // class beside it is then the deliberate below-640px value, not a
        // mistake.
        if (tokens.some((t) => t.startsWith("sm:"))) continue;

        for (const cls of tokens) {
          if (/^[a-z0-9.-]+:/.test(cls)) continue; // some other variant, fine
          violations.push({ rel, line, tag, cls });
        }
      }
    }
  }
}

if (unparsed.length) {
  console.error(
    "[dialog-width-guard] Could not parse these opening tags, so they were " +
      "not checked. Fix the parser or simplify the tag:"
  );
  for (const u of unparsed) console.error(`  ${u}`);
}

if (violations.length) {
  console.error(
    `\n[dialog-width-guard] ${violations.length} unprefixed max-w-* override(s) found.\n`
  );
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}`);
    console.error(`    <${v.tag}> declares "${v.cls}" with no variant prefix.`);
    console.error(
      `    It will NOT take effect — the component's own sm: cap wins at >= 640px.`
    );
    console.error(`    Use "sm:${v.cls}", or drop the class to accept the base cap.\n`);
  }
}

if (violations.length || unparsed.length) process.exit(1);

console.log(
  "[dialog-width-guard] OK: every Dialog/AlertDialog/Sheet width override is variant-prefixed."
);
