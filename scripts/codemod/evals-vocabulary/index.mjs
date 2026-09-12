#!/usr/bin/env node
/**
 * Evaluator-vocabulary codemod — the REPORT half.
 *
 * It proposes renames and refuses to perform them. There is no `--write`, and
 * that is the design rather than an unfinished edge: the words this program
 * renames are ordinary English in this repository and load-bearing identifiers
 * in four unrelated subsystems, so the value here is the inventory a reviewer
 * reads, not the edit a script makes. Every actual rename lands in a PR a human
 * reviews against the pinned contract in
 * `docs/evals-vocabulary-consolidation.md`.
 *
 * WHY IT PARSES RATHER THAN GREPS. `checks`, `predicates` and `repetitions`
 * appear in prose, in comments, in GitHub-check plumbing, in OAuth conformance,
 * in billing trials and in test fixtures. A line-based match reports all of
 * them, a reviewer stops reading at the fiftieth false positive, and the report
 * has bought nothing.
 *
 * It uses the TypeScript PARSER, not the raw scanner, and the difference is not
 * academic. A bare `createScanner` has no parser context, so the text after an
 * interpolation in a template literal comes back as ordinary identifier tokens,
 * and so does JSX text — which put `Scorer` from two doc comments into the
 * first version of this report. A parsed tree cannot make that mistake: a word
 * inside a string is a string, a property name is a property name, and
 * `row?.checks` is the same node shape as `row.checks`. TypeScript is already
 * installed for the build, so this costs no new dependency and no lockfile
 * entry.
 *
 * THE PROTECTED RULE, in two severities:
 *
 *   - Proposing to mutate a protected term, or anything inside a protected
 *     path, is a HARD FAILURE (exit 2). The scanner cannot tell a GitHub check
 *     run from a grading check by looking at the token, so it refuses to guess.
 *   - A proposed mutation on a line that merely MENTIONS a protected term is
 *     reported for human review and does not fail. `evaluatorErrorRate` sits
 *     beside real evaluator code all over the verdict policy; failing on
 *     proximity would make the tool unrunnable and teach everyone to skip it.
 *
 * Exit codes: 0 clean report · 1 scan error (fails closed, like the runtime
 * guards) · 2 a protected term or path was proposed for mutation.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require("typescript");

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};

// The two tables are overridable so the refusal below can be tested against a
// mapping that genuinely proposes a protected term. Nothing in the repository
// passes these — a guard nobody can exercise is a guard nobody can trust, and
// the committed mapping deliberately proposes no protected word at all.
const mapping = JSON.parse(
  readFileSync(flagValue("--mapping", join(here, "mapping.json")), "utf8")
);
const protectedSpec = JSON.parse(
  readFileSync(flagValue("--protected", join(here, "protected.json")), "utf8")
);
const rootArgIndex = args.indexOf("--root");
const ROOT = resolve(
  rootArgIndex >= 0
    ? args[rootArgIndex + 1] ?? "."
    : join(here, "..", "..", "..")
);
const AS_JSON = args.includes("--json");

if (args.includes("--write")) {
  console.error(
    "This scanner has no --write. Every rename lands in a reviewed PR; see the header."
  );
  process.exit(1);
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".changeset",
]);
const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
]);
const TEXT_EXT = new Set([".md", ".mdx", ".json", ".yml", ".yaml"]);

function walk(dir, out, failures) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    failures.push({ file: dir, reason: String(error) });
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch (error) {
      failures.push({ file: full, reason: String(error) });
      continue;
    }
    if (stat.isDirectory()) walk(full, out, failures);
    else out.push(full);
  }
  return out;
}

const isProtectedPath = (rel) =>
  protectedSpec.paths.some((p) => rel === p || rel.startsWith(p)) ||
  protectedSpec.pathSuffixes.some((s) => rel.endsWith(s));

const protectedTermsOnLine = (line) =>
  protectedSpec.terms.filter((term) => line.includes(term));

const inAllowedPaths = (rel, paths) =>
  !paths || paths.some((p) => rel === p || rel.startsWith(p));

const byScope = (scope) => mapping.renames.filter((r) => r.scope === scope);
const identifierRenames = new Map(
  byScope("identifier").map((r) => [r.from, r])
);
const subpathRenames = new Map(byScope("subpath").map((r) => [r.from, r]));
const wireFieldRenames = byScope("wire-field");
const flagRenames = byScope("flag");

/** The script kind a parse needs, so JSX is parsed as JSX rather than as `<`. */
function scriptKindOf(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

/**
 * Every node the mapping can match, classified by what it IS rather than by
 * what token happened to precede it.
 *
 * "Field" covers all five shapes a wire field takes: the declaration
 * (`checks:`), the OPTIONAL declaration (`checks?:`), the shorthand
 * (`{ checks }`), the destructured binding, and the read — including the
 * optional read, because `row?.checks` and `row.checks` are one node shape. The
 * token lookahead this replaced saw only the first of the five, which is why
 * `repetitions?: number` in the platform types was missing from the inventory
 * the renames are meant to enumerate.
 */
function interestingNodes(text, file) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindOf(file)
  );
  const found = [];

  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertySignature(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isMethodSignature(parent) ||
          ts.isEnumMember(parent) ||
          ts.isBindingElement(parent)) &&
        parent.name === node;
      const isMember =
        (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) &&
        (parent.name === node || parent.right === node);
      const isShorthand = ts.isShorthandPropertyAssignment(parent);

      found.push({
        value: node.text,
        start: node.getStart(source),
        isIdentifier: !isPropertyName && !isMember && !isShorthand,
        isField: isPropertyName || isMember || isShorthand,
      });
      return;
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      const isSpecifier =
        ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
          parent.moduleSpecifier === node) ||
        (ts.isCallExpression(parent) &&
          (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
            parent.expression.getText(source) === "require")) ||
        ts.isImportTypeNode(parent) ||
        ts.isLiteralTypeNode(parent);
      const isKey =
        (ts.isPropertySignature(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isPropertyDeclaration(parent)) &&
        parent.name === node;

      found.push({
        value: node.text,
        start: node.getStart(source),
        isSpecifier,
        isField: isKey,
      });
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return found;
}

const lineIndexOf = (text) => {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1)
    if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
};

const findings = [];
const violations = [];
const reviewByHand = [];
/**
 * Files the walk or a read could not inspect.
 *
 * Collected rather than swallowed, and fatal at the end. A scanner that skips
 * an unreadable file and then reports `ok` has produced an inventory with a
 * hole that reads as complete — which is the one output worse than no output,
 * because the next person renames from it.
 */
const unreadable = [];

function record(rel, line, lineText, rename, matched) {
  const entry = {
    file: rel,
    line,
    matched,
    from: rename.from,
    to: rename.to,
    scope: rename.scope,
    text: lineText.trim().slice(0, 160),
  };
  if (isProtectedPath(rel)) {
    violations.push({ ...entry, reason: `protected path` });
    return;
  }
  if (protectedSpec.terms.includes(matched)) {
    violations.push({ ...entry, reason: `protected term` });
    return;
  }
  const nearby = protectedTermsOnLine(lineText).filter((t) => t !== matched);
  if (nearby.length > 0) reviewByHand.push({ ...entry, nearby });
  findings.push(entry);
}

const files = walk(ROOT, [], unreadable);

let scanned = 0;
for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join("/");
  const ext = file.slice(file.lastIndexOf("."));
  const isCode = CODE_EXT.has(ext);
  const isText = TEXT_EXT.has(ext);
  if (!isCode && !isText) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    unreadable.push({ file: rel, reason: String(error) });
    continue;
  }
  scanned += 1;
  const lines = text.split("\n");
  const lineOf = lineIndexOf(text);

  if (isCode) {
    let nodes;
    try {
      nodes = interestingNodes(text, file);
    } catch (error) {
      // A file the parser cannot read is a hole in the inventory, and an
      // inventory with a hole in it is worse than no inventory: it reads as
      // complete. Fail closed.
      unreadable.push({ file: rel, reason: String(error) });
      continue;
    }

    for (const node of nodes) {
      const line = lineOf(node.start);
      const lineText = lines[line - 1] ?? "";

      if (node.isIdentifier) {
        const rename = identifierRenames.get(node.value);
        if (rename && inAllowedPaths(rel, rename.paths)) {
          record(rel, line, lineText, rename, node.value);
        }
      }

      if (node.isSpecifier) {
        const rename = subpathRenames.get(node.value);
        // Path-scoped like every other mapping: an override that names `paths`
        // must not report from outside them just because it is a subpath.
        if (rename && inAllowedPaths(rel, rename.paths)) {
          record(rel, line, lineText, rename, node.value);
        }
      }

      if (node.isField) {
        for (const rename of wireFieldRenames) {
          if (node.value !== rename.from) continue;
          if (!inAllowedPaths(rel, rename.paths)) continue;
          record(rel, line, lineText, rename, node.value);
        }
      }
    }
  }

  for (const rename of flagRenames) {
    if (!inAllowedPaths(rel, rename.paths)) continue;
    // A whole flag token, not a substring: `--repetitions-old` is a different
    // flag, and proposing to rename it would be proposing to break it. The
    // trailing class accepts `--repetitions` alone and `--repetitions=3`.
    const flag = new RegExp(
      `${rename.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`
    );
    lines.forEach((lineText, index) => {
      if (flag.test(lineText)) {
        record(rel, index + 1, lineText, rename, rename.from);
      }
    });
  }
}

if (unreadable.length > 0) {
  console.error(
    `\n${unreadable.length} path(s) could not be inspected. No report was ` +
      `written — an inventory with a hole in it reads as complete, and the ` +
      `next person renames from it.\n`
  );
  for (const entry of unreadable.slice(0, 20)) {
    console.error(`  ✗ ${entry.file}`);
    console.error(`      ${entry.reason}`);
  }
  process.exit(1);
}

if (scanned === 0) {
  // The RAW walk finding files is not the same as having read any: a root of
  // nothing but images, or of unreadable sources, would otherwise produce a
  // clean empty report indistinguishable from a clean real one.
  console.error(
    `No supported files were read under ${ROOT} — refusing to report a clean run.`
  );
  process.exit(1);
}

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        status: violations.length > 0 ? "protected" : "ok",
        root: ROOT,
        scanned,
        findings,
        reviewByHand,
        violations,
      },
      null,
      2
    )
  );
  process.exit(violations.length > 0 ? 2 : 0);
}

if (violations.length > 0) {
  console.error(
    `\nThe mapping proposes to mutate ${violations.length} protected occurrence(s). ` +
      `No report was written.\n`
  );
  for (const v of violations) {
    console.error(
      `  ✗ ${v.file}:${v.line}  ${v.from} → ${v.to}  (${v.reason})`
    );
    console.error(`      ${v.text}`);
  }
  console.error(
    `\nThese words mean something else — GitHub check runs, OAuth conformance, ` +
      `SAML assertions, billing trials, the evaluator-ERROR family. Narrow the ` +
      `mapping's \`paths\`, or take the occurrence out of scope. Do not widen ` +
      `protected.json to make this pass.\n`
  );
  process.exit(2);
}

/**
 * Render one captured source line as a table cell.
 *
 * Two hazards, and the first is why CodeQL flagged the previous version. A `|`
 * splits the table, so it has to be escaped — but escaping it with a backslash
 * while leaving literal backslashes alone means `\\|` in the source becomes a
 * cell that ends in an escape for a pipe that is not there. Backslashes go
 * first, always.
 *
 * The second: a captured line may contain backticks, and a run of them closes
 * the span early — which happened on the first generated report, where a
 * commented `\`predicate:<type>#<ordinal>\`` broke the table from that row
 * down. CommonMark's own rule is the fix: a span delimited by N backticks can
 * contain any run shorter than N.
 */
function codeCell(text) {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  const longestRun = Math.max(
    0,
    ...[...escaped.matchAll(/`+/g)].map((match) => match[0].length)
  );
  const fence = "`".repeat(longestRun + 1);
  // A span whose content starts or ends with a backtick needs one space of
  // padding, which CommonMark strips on render.
  const pad = escaped.startsWith("`") || escaped.endsWith("`") ? " " : "";
  return `${fence}${pad}${escaped}${pad}${fence}`;
}

const grouped = new Map();
for (const finding of findings) {
  const key = `${finding.from} → ${finding.to}`;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(finding);
}

const out = [];
out.push("# Evaluator-vocabulary codemod — proposed renames");
out.push("");
out.push(
  `Generated by \`scripts/codemod/evals-vocabulary/index.mjs\`. Report only: nothing here has been ` +
    `applied, and this scanner cannot apply it. ${findings.length} occurrence(s) across ` +
    `${
      new Set(findings.map((f) => f.file)).size
    } file(s), from ${scanned} scanned.`
);
out.push("");
out.push(
  `The contract these renames implement is \`docs/evals-vocabulary-consolidation.md\`. Anything ` +
    `not listed there is out of scope for this program.`
);
out.push("");
out.push("## Summary");
out.push("");
out.push("| rename | scope | occurrences | files |");
out.push("|---|---|---:|---:|");
for (const [key, entries] of [...grouped].sort(
  (a, b) => b[1].length - a[1].length
)) {
  out.push(
    `| \`${key}\` | ${entries[0].scope} | ${entries.length} | ${
      new Set(entries.map((e) => e.file)).size
    } |`
  );
}
out.push("");

if (reviewByHand.length > 0) {
  out.push("## Review by hand");
  out.push("");
  out.push(
    `${reviewByHand.length} proposed rename(s) sit on a line that also mentions a protected term. ` +
      `Not a failure — the evaluator-error family and the eval evaluators genuinely live beside ` +
      `each other — but each one is a place where a careless edit renames the wrong thing.`
  );
  out.push("");
  out.push("| file:line | rename | also on this line |");
  out.push("|---|---|---|");
  for (const entry of reviewByHand.slice(0, 100)) {
    out.push(
      `| \`${entry.file}:${entry.line}\` | \`${entry.from} → ${
        entry.to
      }\` | ${entry.nearby.map((n) => `\`${n}\``).join(", ")} |`
    );
  }
  if (reviewByHand.length > 100)
    out.push(`| … | ${reviewByHand.length - 100} more | |`);
  out.push("");
}

for (const [key, entries] of [...grouped].sort(
  (a, b) => b[1].length - a[1].length
)) {
  const rename = mapping.renames.find((r) => `${r.from} → ${r.to}` === key);
  out.push(`## \`${key}\``);
  out.push("");
  if (rename?.note) {
    out.push(`> ${rename.note}`);
    out.push("");
  }
  out.push("| file:line | line |");
  out.push("|---|---|");
  for (const entry of entries.slice(0, 60)) {
    out.push(`| \`${entry.file}:${entry.line}\` | ${codeCell(entry.text)} |`);
  }
  if (entries.length > 60)
    out.push(`| … | ${entries.length - 60} more occurrence(s) |`);
  out.push("");
}

console.log(out.join("\n"));
