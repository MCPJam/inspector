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
 * ---------------------------------------------------------------------------
 * Exactly what earns the exemption
 *
 * A tag is exempt when it carries a token whose variant chain is EXACTLY
 * `sm:` — i.e. it matches `/^sm:max-w-/`. Only that form reliably replaces the
 * base cap at every viewport >= 640px, which is the whole point.
 *
 * Deliberately NOT exempt, because none of these actually displace the base:
 *
 *   sm:hover:max-w-2xl   applies only while hovering; the base wins otherwise
 *   dark:sm:max-w-2xl    higher specificity, but only in dark mode
 *   md:sm:max-w-2xl      nests to >= 768px, so the base wins from 640 to 768
 *
 * In each case an accompanying unprefixed `max-w-*` really is dead at >= 640px
 * in the ordinary state, so flagging it is correct rather than a false alarm.
 *
 * An unprefixed `max-w-*` sitting NEXT TO a plain `sm:max-w-*` is fine and
 * expected: that is the two-breakpoint form, where the unprefixed class
 * knowingly replaces the base `max-w-[calc(100%-2rem)]` below 640px while the
 * prefixed one governs above it. `eval-runner`, `CiEvalsTab`,
 * `attachment-editor`, `HostFocusDialog` and `file-attachment-card` all use it.
 *
 * ---------------------------------------------------------------------------
 * Out of scope on purpose
 *
 * A variant-chained override with no unprefixed companion (`lg:max-w-4xl` on
 * its own, say) is left alone. The author is choosing a breakpoint, and
 * "512px until lg, then 896" is a legitimate design. This guard is about the
 * unprefixed mistake, which is wrong every time.
 *
 * Known blind spots:
 *   - A className assembled from an imported constant is opaque here. This
 *     catches the literal form, which is how all 89 current call sites are
 *     written.
 *   - A `SheetContent` whose `side` is a variable is checked as though it were
 *     left/right. Top and bottom sheets carry no `max-w-*` in their base, so
 *     there is nothing for an override to lose; a literal `side="top"` or
 *     `side="bottom"` is skipped, but a computed one cannot be resolved here.
 *
 * Run with `--self-test` to exercise the rules above in isolation. The check
 * runs them on every invocation regardless, so a broken rule fails loudly
 * instead of quietly passing everything.
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

/**
 * A `max-w-*` utility with any leading variant chain (`sm:`, `lg:`,
 * `dark:sm:`, ...).
 *
 * Three value forms, matched whole so that a `:` or `-` inside one is never
 * mistaken for a variant separator or a word boundary:
 *   max-w-2xl              named scale
 *   max-w-[calc(100%-2rem)]  v3-style arbitrary value
 *   max-w-(--app-width)      v4 shorthand for `[var(--app-width)]`
 *
 * The parenthesized form matters: this repo is on Tailwind v4 (^4.1.11), so
 * `max-w-(--x)` is valid today and would otherwise slip through unseen.
 */
const MAX_W =
  /(?:^|[\s"'`])((?:[a-z0-9.-]+:)*max-w-(?:\[[^\]]*\]|\([^)]*\)|[\w./-]+))/g;

/** The only variant chain that fully replaces the base cap. */
const SM_OVERRIDE = /^sm:max-w-/;

/** Any variant chain at all, used to leave non-`sm:` overrides alone. */
const ANY_VARIANT = /^[a-z0-9.-]+:/;

/**
 * A sheet pinned to the top or bottom edge. Those two sides carry no
 * `max-w-*` in `SheetContent`'s base (only left/right get `sm:max-w-sm`), so
 * an unprefixed override there has nothing to lose and is perfectly valid.
 *
 * The lookbehind is load-bearing. A `\b` here would also match the `side` in
 * `data-side="top"` or `aria-side="top"`, so a right-side sheet carrying one
 * of those as a styling hook would be waved through with the exact unprefixed
 * override this guard exists to catch. `data-side` is not hypothetical in
 * this repo — `components/ui/sidebar.tsx` already uses it. Only a standalone
 * JSX `side` prop counts.
 */
const TOP_OR_BOTTOM_SHEET =
  /(?<![\w-])side\s*=\s*\{?\s*["'](?:top|bottom)["']/;

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

/** Collect violations and unreadable tags from one file's source. */
function scanSource(src, rel) {
  const violations = [];
  const unparsed = [];

  for (const tag of TAGS) {
    const re = new RegExp(`<${tag}(?![A-Za-z0-9_])`, "g");
    let m;
    while ((m = re.exec(src))) {
      const tagSrc = readOpeningTag(src, m.index + tag.length + 1);
      const line = src.slice(0, m.index).split("\n").length;

      if (tagSrc === null) {
        unparsed.push({ rel, line, tag });
        continue;
      }

      // No base cap to lose on these, so any override form is fine.
      if (tag === "SheetContent" && TOP_OR_BOTTOM_SHEET.test(tagSrc)) continue;

      const tokens = [...tagSrc.matchAll(MAX_W)].map((hit) => hit[1]);
      if (tokens.some((t) => SM_OVERRIDE.test(t))) continue;

      for (const cls of tokens) {
        if (ANY_VARIANT.test(cls)) continue;
        violations.push({ rel, line, tag, cls });
      }
    }
  }

  return { violations, unparsed };
}

// ---------------------------------------------------------------------------
// Self-test. Each case is a snippet plus the classes it must report.

const SELF_TEST = [
  {
    name: "plain unprefixed override is caught",
    src: `<DialogContent className="max-w-2xl max-h-[80vh]">x</DialogContent>`,
    expect: ["max-w-2xl"],
  },
  {
    name: "v4 parenthesized arbitrary value is caught",
    src: `<DialogContent className="max-w-(--app-dialog)">x</DialogContent>`,
    expect: ["max-w-(--app-dialog)"],
  },
  {
    name: "hover-qualified sm: does not exempt its unprefixed companion",
    src: `<DialogContent className="sm:hover:max-w-2xl max-w-md">x</DialogContent>`,
    expect: ["max-w-md"],
  },
  {
    name: "dark-qualified sm: does not exempt either",
    src: `<DialogContent className="dark:sm:max-w-2xl max-w-md">x</DialogContent>`,
    expect: ["max-w-md"],
  },
  {
    name: "plain sm: exempts the two-breakpoint form",
    src: `<DialogContent className="max-w-[calc(100vw-32px)] sm:max-w-[820px]">x</DialogContent>`,
    expect: [],
  },
  {
    name: "sm: plus a larger breakpoint is fine",
    src: `<DialogContent className="sm:max-w-3xl lg:max-w-4xl">x</DialogContent>`,
    expect: [],
  },
  {
    name: "a lone non-sm variant is left alone",
    src: `<DialogContent className="lg:max-w-4xl">x</DialogContent>`,
    expect: [],
  },
  {
    name: "no width declared is fine",
    src: `<DialogContent>x</DialogContent>`,
    expect: [],
  },
  {
    name: "class names quoted inside a comment are not classes",
    src: [
      `<DialogContent`,
      `  // Prefer sm:max-w-2xl here; a bare max-w-2xl would lose at >= 640px.`,
      `  className="sm:max-w-2xl"`,
      `>x</DialogContent>`,
    ].join("\n"),
    expect: [],
  },
  {
    name: "an arrow function in a prop does not end the tag early",
    src: `<DialogContent onOpenChange={(o) => setOpen(o)} className="max-w-2xl">x</DialogContent>`,
    expect: ["max-w-2xl"],
  },
  {
    name: "AlertDialogContent is covered too",
    src: `<AlertDialogContent className="max-w-2xl">x</AlertDialogContent>`,
    expect: ["max-w-2xl"],
  },
  {
    name: "a right sheet inherits sm:max-w-sm, so it is checked",
    src: `<SheetContent side="right" className="max-w-4xl">x</SheetContent>`,
    expect: ["max-w-4xl"],
  },
  {
    name: "a sheet with no side defaults to right, so it is checked",
    src: `<SheetContent className="max-w-4xl">x</SheetContent>`,
    expect: ["max-w-4xl"],
  },
  {
    name: "a top sheet has no base cap, so it is skipped",
    src: `<SheetContent side="top" className="max-w-4xl">x</SheetContent>`,
    expect: [],
  },
  {
    name: "a bottom sheet is skipped as well",
    src: `<SheetContent side="bottom" className="max-w-4xl">x</SheetContent>`,
    expect: [],
  },
  {
    name: "data-side does not stand in for the side prop",
    src: `<SheetContent data-side="top" className="max-w-4xl">x</SheetContent>`,
    expect: ["max-w-4xl"],
  },
  {
    name: "data-side cannot override a real right-side prop",
    src: `<SheetContent side="right" data-side="top" className="max-w-4xl">x</SheetContent>`,
    expect: ["max-w-4xl"],
  },
  {
    name: "aria-side does not stand in either",
    src: `<SheetContent aria-side="bottom" className="max-w-4xl">x</SheetContent>`,
    expect: ["max-w-4xl"],
  },
  {
    name: "a side prop in braces still counts",
    src: `<SheetContent side={"top"} className="max-w-4xl">x</SheetContent>`,
    expect: [],
  },
  {
    name: "a computed side is checked rather than assumed",
    src: `<SheetContent side={side} className="max-w-4xl">x</SheetContent>`,
    expect: ["max-w-4xl"],
  },
];

function runSelfTest() {
  const failures = [];
  for (const testCase of SELF_TEST) {
    const { violations, unparsed } = scanSource(testCase.src, "<self-test>");
    const got = violations.map((v) => v.cls);
    const same =
      got.length === testCase.expect.length &&
      got.every((c, i) => c === testCase.expect[i]);
    if (!same || unparsed.length) {
      failures.push(
        `  ${testCase.name}\n` +
          `    expected [${testCase.expect.join(", ")}]\n` +
          `    got      [${got.join(", ")}]` +
          (unparsed.length ? `\n    plus ${unparsed.length} unreadable tag(s)` : "")
      );
    }
  }
  return failures;
}

const selfTestFailures = runSelfTest();
if (selfTestFailures.length) {
  console.error(
    `[dialog-width-guard] SELF-TEST FAILED — ${selfTestFailures.length} of ` +
      `${SELF_TEST.length} cases. The guard's own rules are broken, so its ` +
      `verdict on the codebase means nothing.\n`
  );
  for (const f of selfTestFailures) console.error(`${f}\n`);
  process.exit(1);
}

if (process.argv.includes("--self-test")) {
  console.log(`[dialog-width-guard] self-test OK: ${SELF_TEST.length} cases.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Repository scan.

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

const violations = [];
const unparsed = [];

for (const root of ROOTS) {
  for (const file of walk(join(REPO, root))) {
    const rel = relative(REPO, file).replace(/\\/g, "/");
    const found = scanSource(readFileSync(file, "utf8"), rel);
    violations.push(...found.violations);
    unparsed.push(...found.unparsed);
  }
}

if (unparsed.length) {
  console.error(
    "[dialog-width-guard] Could not parse these opening tags, so they were " +
      "not checked. Fix the parser or simplify the tag:"
  );
  for (const u of unparsed) console.error(`  ${u.rel}:${u.line}  <${u.tag}>`);
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
  `[dialog-width-guard] OK: every Dialog/AlertDialog/Sheet width override is ` +
    `variant-prefixed (self-test: ${SELF_TEST.length} cases).`
);
