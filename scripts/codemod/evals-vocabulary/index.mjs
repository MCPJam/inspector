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
 * WHY IT TOKENIZES RATHER THAN GREPS. `checks`, `predicates` and `repetitions`
 * appear in prose, in GitHub-check plumbing, in OAuth conformance, in billing
 * trials and in comments. A line-based match reports all of them, a reviewer
 * stops reading at the fiftieth false positive, and the report has bought
 * nothing. The TypeScript scanner is already installed for the build, so
 * distinguishing an identifier from a word inside a comment costs no new
 * dependency and no lockfile entry.
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
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};

// The two tables are overridable so the refusal below can be tested against a
// mapping that genuinely proposes a protected term. Nothing in the repository
// passes these — a guard nobody can exercise is a guard nobody can trust, and
// the committed mapping deliberately proposes no protected word at all.
const mapping = JSON.parse(
  readFileSync(flagValue("--mapping", join(here, "mapping.json")), "utf8"),
);
const protectedSpec = JSON.parse(
  readFileSync(flagValue("--protected", join(here, "protected.json")), "utf8"),
);
const rootArgIndex = args.indexOf("--root");
const ROOT = resolve(
  rootArgIndex >= 0 ? (args[rootArgIndex + 1] ?? ".") : join(here, "..", "..", ".."),
);
const AS_JSON = args.includes("--json");

if (args.includes("--write")) {
  console.error(
    "This scanner has no --write. Every rename lands in a reviewed PR; see the header.",
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
const CODE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"]);
const TEXT_EXT = new Set([".md", ".mdx", ".json", ".yml", ".yaml"]);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, out);
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
const identifierRenames = new Map(byScope("identifier").map((r) => [r.from, r]));
const subpathRenames = new Map(byScope("subpath").map((r) => [r.from, r]));
const wireFieldRenames = byScope("wire-field");
const flagRenames = byScope("flag");

/** Tokenize once and hand back every identifier, string and object key with its position. */
function tokensOf(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ true, ts.LanguageVariant.JSX, text);
  const tokens = [];
  let kind = scanner.scan();
  let previous = null;
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    const start = scanner.getTokenStart();
    const value =
      kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
        ? scanner.getTokenValue()
        : scanner.getTokenText();
    tokens.push({ kind, value, start, previous });
    previous = { kind, value };
    kind = scanner.scan();
  }
  // An object KEY is an identifier or string immediately followed by `:`; a
  // property READ is one immediately preceded by `.`. Both are the field, and
  // neither is the same as the word appearing in a comment.
  for (let i = 0; i < tokens.length; i += 1) {
    const next = tokens[i + 1];
    const prev = tokens[i - 1];
    tokens[i].isKey = next?.kind === ts.SyntaxKind.ColonToken;
    tokens[i].isMember = prev?.kind === ts.SyntaxKind.DotToken;
  }
  return tokens;
}

const lineIndexOf = (text) => {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
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

const files = walk(ROOT, []);
if (files.length === 0) {
  console.error(`No files scanned under ${ROOT} — refusing to report a clean run.`);
  process.exit(1);
}

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
  } catch {
    continue;
  }
  scanned += 1;
  const lines = text.split("\n");
  const lineOf = lineIndexOf(text);

  if (isCode) {
    for (const token of tokensOf(text)) {
      const line = lineOf(token.start);
      const lineText = lines[line - 1] ?? "";

      if (token.kind === ts.SyntaxKind.Identifier) {
        const rename = identifierRenames.get(token.value);
        if (rename && inAllowedPaths(rel, rename.paths)) {
          record(rel, line, lineText, rename, token.value);
        }
      }

      if (
        token.kind === ts.SyntaxKind.StringLiteral ||
        token.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
      ) {
        const rename = subpathRenames.get(token.value);
        if (rename) record(rel, line, lineText, rename, token.value);
      }

      if (token.isKey || token.isMember) {
        for (const rename of wireFieldRenames) {
          if (token.value !== rename.from) continue;
          if (!inAllowedPaths(rel, rename.paths)) continue;
          record(rel, line, lineText, rename, token.value);
        }
      }
    }
  }

  for (const rename of flagRenames) {
    if (!inAllowedPaths(rel, rename.paths)) continue;
    lines.forEach((lineText, index) => {
      if (lineText.includes(rename.from)) {
        record(rel, index + 1, lineText, rename, rename.from);
      }
    });
  }
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
      2,
    ),
  );
  process.exit(violations.length > 0 ? 2 : 0);
}

if (violations.length > 0) {
  console.error(
    `\nThe mapping proposes to mutate ${violations.length} protected occurrence(s). ` +
      `No report was written.\n`,
  );
  for (const v of violations) {
    console.error(`  ✗ ${v.file}:${v.line}  ${v.from} → ${v.to}  (${v.reason})`);
    console.error(`      ${v.text}`);
  }
  console.error(
    `\nThese words mean something else — GitHub check runs, OAuth conformance, ` +
      `SAML assertions, billing trials, the evaluator-ERROR family. Narrow the ` +
      `mapping's \`paths\`, or take the occurrence out of scope. Do not widen ` +
      `protected.json to make this pass.\n`,
  );
  process.exit(2);
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
    `${new Set(findings.map((f) => f.file)).size} file(s), from ${scanned} scanned.`,
);
out.push("");
out.push(
  `The contract these renames implement is \`docs/evals-vocabulary-consolidation.md\`. Anything ` +
    `not listed there is out of scope for this program.`,
);
out.push("");
out.push("## Summary");
out.push("");
out.push("| rename | scope | occurrences | files |");
out.push("|---|---|---:|---:|");
for (const [key, entries] of [...grouped].sort((a, b) => b[1].length - a[1].length)) {
  out.push(
    `| \`${key}\` | ${entries[0].scope} | ${entries.length} | ${new Set(entries.map((e) => e.file)).size} |`,
  );
}
out.push("");

if (reviewByHand.length > 0) {
  out.push("## Review by hand");
  out.push("");
  out.push(
    `${reviewByHand.length} proposed rename(s) sit on a line that also mentions a protected term. ` +
      `Not a failure — the evaluator-error family and the eval evaluators genuinely live beside ` +
      `each other — but each one is a place where a careless edit renames the wrong thing.`,
  );
  out.push("");
  out.push("| file:line | rename | also on this line |");
  out.push("|---|---|---|");
  for (const entry of reviewByHand.slice(0, 100)) {
    out.push(
      `| \`${entry.file}:${entry.line}\` | \`${entry.from} → ${entry.to}\` | ${entry.nearby.map((n) => `\`${n}\``).join(", ")} |`,
    );
  }
  if (reviewByHand.length > 100) out.push(`| … | ${reviewByHand.length - 100} more | |`);
  out.push("");
}

for (const [key, entries] of [...grouped].sort((a, b) => b[1].length - a[1].length)) {
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
    out.push(`| \`${entry.file}:${entry.line}\` | \`${entry.text.replace(/\|/g, "\\|")}\` |`);
  }
  if (entries.length > 60) out.push(`| … | ${entries.length - 60} more occurrence(s) |`);
  out.push("");
}

console.log(out.join("\n"));
