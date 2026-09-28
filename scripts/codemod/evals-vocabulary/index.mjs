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
 * `docs/evals-vocabulary-consolidation.md`, which lands in the Wave 0 pull
 * request rather than in this one — this scanner is independent of it so that
 * either can merge first.
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
 * IT FAILS CLOSED, AND A PARSE ERROR IS ONE. `createSourceFile` recovers from
 * malformed input instead of throwing, so a file the parser could not really
 * read comes back as a tree with the bad region swallowed — and an identifier
 * inside that region is simply absent from the report. Every file's
 * `parseDiagnostics` is therefore checked, and a non-empty one loses the run
 * rather than the guarantee. The whole tree parses clean today, so this gate
 * fires on a file that is actually broken.
 *
 * WHAT IT READS is what git sees: tracked files plus untracked files that are
 * not ignored, through `git ls-files`. A filesystem walk with a hand-kept skip
 * list read ignored `worktrees/` checkouts on a real laptop, took minutes, and
 * reported other branches' code. A root that is not a git work tree falls back
 * to the walk. Symlinks are skipped and listed, never followed: the target is
 * either scanned under its own path or is not this repository's to rename, and
 * a dangling one names nothing at all.
 *
 * TWO FIELDS MUST NOT BECOME ONE. A wire-field rename onto a name its own
 * files still use is refused ("rename target in use") unless another rename
 * vacates that name first, and the dependent rename must say so with `after`
 * ("unordered rename"). See `vacatesAt` below.
 *
 * Exit codes: 0 clean report · 1 scan error (fails closed, like the runtime
 * guards) · 2 a protected term or path was proposed for mutation, or a rename
 * would merge two fields.
 */

import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

/**
 * The fallback enumeration, for a root that is not a git work tree.
 *
 * `lstat`, not `stat`: a symlink is recorded as skipped rather than followed,
 * for the same reasons as in the git path below.
 */
function walk(dir, out, failures, skipped) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    failures.push({ file: relative(ROOT, dir), reason: String(error) });
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = lstatSync(full);
    } catch (error) {
      failures.push({ file: relative(ROOT, full), reason: String(error) });
      continue;
    }
    if (stat.isSymbolicLink()) {
      skipped.push({ file: relative(ROOT, full), reason: symlinkReason(full) });
    } else if (stat.isDirectory()) walk(full, out, failures, skipped);
    else out.push(relative(ROOT, full).split(sep).join("/"));
  }
  return out;
}

function symlinkReason(full) {
  try {
    statSync(full);
    return "symlink (not followed)";
  } catch {
    return "dangling symlink";
  }
}

/**
 * Every candidate path, relative to ROOT with forward slashes.
 *
 * Inside a git work tree this is `git ls-files --cached --others
 * --exclude-standard`: what is tracked, plus what is new and not ignored. The
 * repository's own `.gitignore` is the only skip list that stays true — the
 * hand-kept one it replaces knew nothing about `worktrees/`, and against the
 * backend root it read 51,320 files. If git is absent or the root is not a
 * work tree, the filesystem walk runs instead; if git IS the enumerator and
 * fails, that is fatal, because an empty listing reads as a clean tree.
 */
function listCandidates(failures, skipped) {
  const probe = spawnSync(
    "git",
    ["-C", ROOT, "rev-parse", "--is-inside-work-tree"],
    {
      encoding: "utf8",
    }
  );
  if (probe.error || probe.status !== 0 || probe.stdout.trim() !== "true") {
    return {
      enumeration: "filesystem walk",
      paths: walk(ROOT, [], failures, skipped),
    };
  }
  const listed = spawnSync(
    "git",
    [
      "-C",
      ROOT,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }
  );
  if (listed.error || listed.status !== 0) {
    failures.push({
      file: ".",
      reason: `git ls-files failed: ${listed.error ?? listed.stderr.trim()}`,
    });
    return { enumeration: "git ls-files", paths: [] };
  }
  const paths = [...new Set(listed.stdout.split("\0").filter(Boolean))].filter(
    (rel) => !rel.split("/").some((segment) => SKIP_DIRS.has(segment))
  );
  return { enumeration: "git ls-files", paths };
}

/**
 * The tool's own directory.
 *
 * `mapping.json` names every subpath this program renames and `REPORT.md`
 * quotes them back, so a text scan that included them would report the
 * instructions as work. They are not rename sites; they are the tool.
 */
const TOOL_DIR = "scripts/codemod/evals-vocabulary/";

/**
 * The scanner's own test. Every mapping in it is a fixture that proposes a
 * rename on purpose, so listing it would report the tests as work, and
 * following that row would break the regression the fixture exists to hold.
 */
const SCANNER_TEST = "sdk/tests/codemod-evals-vocabulary.test.ts";

const underPaths = (rel, paths = [], suffixes = []) =>
  paths.some((p) => rel === p || rel.startsWith(p)) ||
  suffixes.some((s) => rel.endsWith(s));

const isProtectedPath = (rel) =>
  underPaths(rel, protectedSpec.paths, protectedSpec.pathSuffixes);

/**
 * Families, not just spellings.
 *
 * An exact-string denylist protected `githubCheck` and nothing spelled after
 * it, so a mapping proposing `githubCheckRunId` — or `GithubCheckRepoConfigRow`,
 * capital G — was reported as ordinary work. Each family's pattern spells its
 * case variants on purpose; matching case-insensitively would make `trial`
 * billing everywhere, and half of it is eval.
 */
const termFamilies = (protectedSpec.termFamilies ?? []).map((family) => ({
  ...family,
  regex: new RegExp(family.pattern),
}));
const protectedFields = protectedSpec.fields ?? [];

const isProtectedTerm = (token) =>
  protectedSpec.terms.includes(token) ||
  termFamilies.some((family) => family.regex.test(token));

const protectedTermsOnLine = (line) => [
  ...protectedSpec.terms.filter((term) => line.includes(term)),
  ...termFamilies
    .filter((family) => family.regex.test(line))
    .map((family) => family.family),
];

/** A field that is only foreign in the files that own it, like mcpjam.yml's `checks:`. */
const protectedFieldAt = (rel, token) =>
  protectedFields.find(
    (field) =>
      field.name === token && underPaths(rel, field.paths, field.pathSuffixes)
  );

const inAllowedPaths = (rel, paths) =>
  !paths || paths.some((p) => rel === p || rel.startsWith(p));

const byScope = (scope) => mapping.renames.filter((r) => r.scope === scope);
const identifierRenames = new Map(
  byScope("identifier").map((r) => [r.from, r])
);
const subpathRenames = new Map(byScope("subpath").map((r) => [r.from, r]));
const wireFieldRenames = byScope("wire-field");
const flagRenames = byScope("flag");

/**
 * Two wire fields must not become one.
 *
 * A rename onto a name its own files already use merges two fields, and from
 * then on the token cannot say which one a row meant. The configured count is
 * the case that forced this: `repetitions` becomes `iterations` in adapters
 * where a legacy `iterations` — which the legacy resolver reads as a FLOOR —
 * already sits on the same object. So the target has to be vacated first, by a
 * rename whose `from` is that name, and the dependent rename names it in
 * `after`. An occurrence of the target with nothing vacating it is refused;
 * a vacated target without `after` is refused at the mapping, because an
 * inventory that does not say which rename lands first invites the blind sweep.
 *
 * `sameMeaning` is the one exemption, and it is a claim about the domain, not
 * a way to go green: the target already names the SAME thing, so joining the
 * spellings is the rename. `checks → assertions` is that case — the suite
 * file's deprecated `assertions` and `checks` are one list of rules. The count
 * is not: a floor and an exact count are two fields, so it may not claim it.
 */
const overlappingPaths = (a, b) =>
  !a || !b || a.some((p) => b.some((q) => p.startsWith(q) || q.startsWith(p)));
const vacatesAt = (rel, name) =>
  wireFieldRenames.some((r) => r.from === name && inAllowedPaths(rel, r.paths));

/** How a matched field-shaped node reads to a reviewer. */
const shapeOf = (node) =>
  node.isField
    ? "field"
    : node.isTypeLiteral
    ? "string in a type"
    : "field named in a string";

/**
 * Compiler options for a one-file program that resolves nothing.
 *
 * `noResolve` and `noLib` are what make this affordable: no module resolution,
 * no `lib.d.ts` load, no walk into `node_modules`. Syntactic diagnostics do not
 * need any of it — they are the parser's own findings — so the program exists
 * purely to reach the supported accessor for them.
 */
const DIAGNOSTIC_OPTIONS = {
  noResolve: true,
  noLib: true,
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.Latest,
};

/**
 * The parser's complaints about one file, through public API.
 *
 * `SourceFile.parseDiagnostics` holds the same information and is a third
 * faster, but it is internal: a TypeScript release may rename it, stop
 * populating it, or keep it and change what it means, and the failure mode of
 * the last one is a gate that silently stops gating. `getSyntacticDiagnostics`
 * is the supported way to ask, so the cost buys a guarantee that survives an
 * upgrade. The already-parsed tree is handed straight to the host, so the file
 * is parsed once, not twice.
 */
function syntacticDiagnostics(source, file, text) {
  const host = {
    getSourceFile: (name) => (name === file ? source : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => ROOT,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === file,
    readFile: (name) => (name === file ? text : undefined),
  };
  return ts
    .createProgram([file], DIAGNOSTIC_OPTIONS, host)
    .getSyntacticDiagnostics(source);
}

/**
 * The script kind a parse needs, so JSX is parsed as JSX rather than as `<`.
 */
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
 * (`{ checks }`), the destructured PROPERTY (`{ checks: local }` reads
 * `checks`, not `local`), and the read — including the optional read, because
 * `row?.checks` and `row.checks` are one node shape. The
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

  // A parse error does NOT throw. `createSourceFile` recovers and hands back a
  // tree with the malformed region swallowed, so a file containing an
  // unterminated template followed by `type Y = Scorer` parses "fine" and
  // reports nothing — the identifier is inside the run-on template as far as
  // the parser is concerned. That is a hole in the inventory that reads as a
  // clean file, so the diagnostics are the gate, not the absence of a throw.
  const diagnostics = syntacticDiagnostics(source, file, text);
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    throw new Error(
      `${diagnostics.length} parse diagnostic(s), first at offset ` +
        `${first.start}: ${ts.flattenDiagnosticMessageText(
          first.messageText,
          " "
        )}`
    );
  }

  const found = [];
  // Comments are trivia, so the walk below never visits them. They are
  // collected where the parser places them, leading and trailing each node,
  // which cannot mistake `//` inside a string or a regular expression for a
  // comment the way a raw text search would.
  const seenComments = new Set();
  const collectComments = (ranges) => {
    for (const range of ranges ?? []) {
      if (seenComments.has(range.pos)) continue;
      seenComments.add(range.pos);
      found.push({
        value: text.slice(range.pos, range.end),
        start: range.pos,
        isComment: true,
      });
    }
  };

  const visit = (node) => {
    collectComments(ts.getLeadingCommentRanges(text, node.pos));
    collectComments(ts.getTrailingCommentRanges(text, node.end));
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const inObjectBinding =
        ts.isBindingElement(parent) && ts.isObjectBindingPattern(parent.parent);
      // `const { checks: local } = row` reads `checks` and declares `local`.
      // The property is the field; the local is just a local. Taking the
      // binding's `name` blamed `local` and lost `checks` entirely. An ARRAY
      // binding (`const [checks] = values`) reads a POSITION, so it names no
      // field however its local happens to be spelled.
      const isAliasedBindingProperty =
        inObjectBinding && parent.propertyName === node;
      const isDeclaredPropertyName =
        (ts.isPropertySignature(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isMethodSignature(parent) ||
          ts.isEnumMember(parent)) &&
        parent.name === node;
      const isMember =
        (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) &&
        (parent.name === node || parent.right === node);
      // A shorthand is ONE identifier doing two jobs, so it belongs to both
      // scopes rather than to whichever is checked first. `const { runScorers
      // } = await import(…)` names an export AND binds a local of the same
      // name; counting it as a field alone hid every identifier rename
      // imported that way. That is exactly how `predicateScorer`,
      // `judgeScorer` and `runScorers` came to be absent from the report
      // while their other uses in the same test file were listed — and the
      // import site is the one line that has to change.
      // A rest element, `const { ...checks } = row`, gathers the REMAINING
      // properties into a local. It reads no property named `checks`.
      const isShorthand =
        (inObjectBinding &&
          !parent.propertyName &&
          !parent.dotDotDotToken &&
          parent.name === node) ||
        ts.isShorthandPropertyAssignment(parent);

      found.push({
        value: node.text,
        start: node.getStart(source),
        isIdentifier:
          !isDeclaredPropertyName && !isAliasedBindingProperty && !isMember,
        isField:
          isDeclaredPropertyName ||
          isAliasedBindingProperty ||
          isMember ||
          isShorthand,
      });
      return;
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      // A string in a TYPE position, like `unit: "iterations" | "sessions"`, is
      // a member of a literal union: usually an enum value, not the name of a
      // field. It still spells the token, so it stays in the inventory, but
      // under its own shape. Labelling it "field named in a string" sent a
      // reviewer looking for a field that is not there.
      const isTypeLiteral = ts.isLiteralTypeNode(parent);
      const isSpecifier =
        ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
          parent.moduleSpecifier === node) ||
        (ts.isCallExpression(parent) &&
          (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
            parent.expression.getText(source) === "require")) ||
        ts.isImportTypeNode(parent);
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
        isTypeLiteral,
        // Matchable wherever it sits. A subpath and a wire field are both
        // named by strings in places that are neither an import nor a
        // property key, and those places break just as loudly: the alias keys
        // and external lists in vite/vitest/tsup configs, a `SuiteSettingsKey`
        // array element like `["defaultPredicates"]`, a Zod `path:
        // ["repetitions"]`. Restricting the match to import-like syntax left
        // every one of them out of an inventory that presents itself as
        // complete. The shape rides along so a reviewer can tell a
        // declaration from a reference without opening the file.
        isString: true,
      });
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  // A comment after the last statement belongs to no statement.
  collectComments(ts.getLeadingCommentRanges(text, source.endOfFileToken.pos));
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
 * Spellings of a rename's `from` that sit outside its `paths`.
 *
 * Not proposals, so no guard runs over them. Collected only for a rename that
 * opts in with `inventoryOutsidePaths`, because for most wire fields the word
 * outside the adapters is English or another subsystem's field, and listing it
 * is the noise path scoping exists to avoid. The configured count is the
 * exception: `repetitions` outside the adapters is still the count, and a
 * report that sized the rename by the adapters alone made a fraction of the
 * work look like all of it. Widening `paths` instead is not an option: it
 * reaches files where `iterations` already names lists of iteration records,
 * and the target-in-use guard rightly refuses that merge.
 */
const outsideMapping = [];
/**
 * Occurrences a rename's `notOnLinesContaining` rule set aside.
 *
 * Listed, never dropped. A rule is a reviewed claim that the word means
 * something else on that line, such as `checks: PlatformEvalCheckRepos` or a
 * list of iteration records, and the report shows what each claim removed so
 * a wrong rule is visible instead of silent.
 */
const excludedByRule = [];
/**
 * Files the walk or a read could not inspect.
 *
 * Collected rather than swallowed, and fatal at the end. A scanner that skips
 * an unreadable file and then reports `ok` has produced an inventory with a
 * hole that reads as complete — which is the one output worse than no output,
 * because the next person renames from it.
 */
const unreadable = [];

function record(rel, line, lineText, rename, matched, shape) {
  const entry = {
    file: rel,
    line,
    matched,
    shape,
    from: rename.from,
    to: rename.to,
    scope: rename.scope,
    text: lineText.trim().slice(0, 160),
  };
  if (isProtectedPath(rel)) {
    violations.push({ ...entry, reason: `protected path` });
    return;
  }
  if (isProtectedTerm(matched) || isProtectedTerm(rename.from)) {
    violations.push({ ...entry, reason: `protected term` });
    return;
  }
  if (protectedFieldAt(rel, matched)) {
    violations.push({ ...entry, reason: `protected field` });
    return;
  }
  // After protection, never before: a rule may set aside another meaning of
  // the word, but it may not hide a protected occurrence.
  const rule = (rename.notOnLinesContaining ?? []).find((needle) =>
    lineText.includes(needle)
  );
  if (rule !== undefined) {
    excludedByRule.push({ ...entry, rule });
    return;
  }
  const nearby = protectedTermsOnLine(lineText).filter((t) => t !== matched);
  if (nearby.length > 0) reviewByHand.push({ ...entry, nearby });
  findings.push(entry);
}

/**
 * The mapping is a proposal whether or not today's tree contains the word.
 *
 * Checked before any file is read, so a protected `from` fails on a checkout
 * that happens not to use it instead of waiting for the first one that does.
 * A protected FIELD fails here when the rename could reach the field's owners:
 * repository-wide, or through a `paths` entry that overlaps theirs.
 */
for (const rename of mapping.renames) {
  const base = {
    file: null,
    line: null,
    matched: rename.from,
    shape: "mapping",
    from: rename.from,
    to: rename.to,
    scope: rename.scope,
    text: `${rename.from} → ${rename.to}`,
  };
  if (isProtectedTerm(rename.from)) {
    violations.push({ ...base, reason: "protected term" });
    continue;
  }
  const overlaps = (a, b) => a.startsWith(b) || b.startsWith(a);
  for (const field of protectedFields) {
    if (field.name !== rename.from) continue;
    const reaches =
      !rename.paths ||
      rename.paths.some(
        (p) =>
          (field.paths ?? []).some((fp) => overlaps(p, fp)) ||
          (field.pathSuffixes ?? []).some((s) => p.endsWith(s))
      );
    if (reaches) violations.push({ ...base, reason: "protected field" });
  }
  if (rename.scope === "wire-field") {
    const vacated = wireFieldRenames.some(
      (other) =>
        other !== rename &&
        other.from === rename.to &&
        overlappingPaths(rename.paths, other.paths)
    );
    if (vacated && rename.after !== rename.to) {
      violations.push({ ...base, reason: "unordered rename" });
    }
  }
  if (
    rename.after !== undefined &&
    !mapping.renames.some(
      (other) => other !== rename && other.from === rename.after
    )
  ) {
    violations.push({ ...base, reason: "after names no rename" });
  }
}

const skipped = [];
const { enumeration, paths: candidates } = listCandidates(unreadable, skipped);

let scanned = 0;
for (const rel of candidates) {
  const file = join(ROOT, rel);
  const ext = rel.slice(rel.lastIndexOf("."));
  const isCode = CODE_EXT.has(ext);
  const isText = TEXT_EXT.has(ext);
  if (!isCode && !isText) continue;
  if (rel === SCANNER_TEST) {
    skipped.push({
      file: rel,
      reason:
        "the scanner's own test: its mappings are fixtures, not rename sites",
    });
    continue;
  }

  // The walk already lstat'ed; git's listing did not. A path git tracks may be
  // a symlink, or deleted from the working tree — neither holds source to
  // rename. Anything else lstat cannot answer is a hole, and fatal.
  let entryStat;
  try {
    entryStat = lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      skipped.push({
        file: rel,
        reason: "listed by git, absent from the working tree",
      });
    } else {
      unreadable.push({ file: rel, reason: String(error) });
    }
    continue;
  }
  if (entryStat.isSymbolicLink()) {
    skipped.push({ file: rel, reason: symlinkReason(file) });
    continue;
  }

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
      // A file the parser could not read — including one it "read" while
      // reporting diagnostics — is a hole in the inventory, and an inventory
      // with a hole in it is worse than no inventory: it reads as complete.
      // Fail closed.
      unreadable.push({ file: rel, reason: String(error) });
      continue;
    }

    for (const node of nodes) {
      // A package subpath named in a comment, such as a module's doc header,
      // advertises an entry point just as an import does. Subpaths only: a
      // wire field in prose is English. The tool's own files quote every
      // subpath as instructions, so they are not rename sites.
      if (node.isComment) {
        if (rel.startsWith(TOOL_DIR)) continue;
        for (const [from, rename] of subpathRenames) {
          if (!inAllowedPaths(rel, rename.paths)) continue;
          const token = new RegExp(
            `${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`,
            "g"
          );
          for (const match of node.value.matchAll(token)) {
            const commentLine = lineOf(node.start + match.index);
            record(
              rel,
              commentLine,
              lines[commentLine - 1] ?? "",
              rename,
              from,
              "comment reference"
            );
          }
        }
        continue;
      }
      const line = lineOf(node.start);
      const lineText = lines[line - 1] ?? "";

      if (node.isIdentifier) {
        const rename = identifierRenames.get(node.value);
        if (rename && inAllowedPaths(rel, rename.paths)) {
          record(rel, line, lineText, rename, node.value, "identifier");
        }
      }

      // Any string that spells the subpath, not just an import of it. A
      // package subpath is never prose, so there is no noise to trade away
      // here — and the references that are NOT imports are the ones that
      // break silently: `{ find: "@mcpjam/sdk/predicates" }` in three vitest
      // configs, the alias keys in `client/vite.config.ts` and
      // `server/tsup.config.ts`, and that file's `external` list. Rename the
      // entry point while following an inventory that omits them and the
      // builds and tests resolve a subpath that no longer exists.
      if (node.isSpecifier || node.isString) {
        const rename = subpathRenames.get(node.value);
        // Path-scoped like every other mapping: an override that names `paths`
        // must not report from outside them just because it is a subpath.
        if (rename && inAllowedPaths(rel, rename.paths)) {
          record(
            rel,
            line,
            lineText,
            rename,
            node.value,
            node.isSpecifier ? "import specifier" : "module reference"
          );
        }
      }

      // A field is also named by the strings that address it. Still bounded by
      // `paths`, which is what keeps `checks` in prose out of this: inside the
      // adapter files a string that spells the field IS the field.
      if (node.isField || node.isString) {
        for (const rename of wireFieldRenames) {
          if (node.value !== rename.from) continue;
          if (!inAllowedPaths(rel, rename.paths)) {
            if (rename.inventoryOutsidePaths && !isProtectedPath(rel)) {
              outsideMapping.push({
                file: rel,
                line,
                matched: node.value,
                shape: shapeOf(node),
                from: rename.from,
                to: rename.to,
                scope: rename.scope,
                text: lineText.trim().slice(0, 160),
                // A hash-payload key that must never move: listed, so the
                // count of what is left says plainly what is not work.
                frozen: Boolean(protectedFieldAt(rel, node.value)),
              });
            }
            continue;
          }
          record(rel, line, lineText, rename, node.value, shapeOf(node));
        }
        for (const rename of wireFieldRenames) {
          if (node.value !== rename.to) continue;
          if (rename.sameMeaning) continue;
          if (!inAllowedPaths(rel, rename.paths)) continue;
          if (vacatesAt(rel, rename.to)) continue;
          violations.push({
            file: rel,
            line,
            matched: node.value,
            shape: shapeOf(node),
            from: rename.from,
            to: rename.to,
            scope: rename.scope,
            text: lineText.trim().slice(0, 160),
            reason: "rename target in use",
          });
        }
      }
    }
  }

  // A package subpath in prose or in a manifest is still a reference to it.
  // Text files get no AST, so they were invisible to the subpath scope
  // entirely: the packaging assertion in `sdk/package.json` imports
  // `@mcpjam/sdk/predicates` from inside a shell string, and three docs pages
  // show it in examples readers copy. Remove the entry point while following
  // an inventory that omitted them and the packaging test imports a subpath
  // that is gone and the published examples teach it.
  //
  // Subpaths ONLY here, never wire fields. `@mcpjam/sdk/predicates` is an
  // unambiguous token that cannot occur by accident; `checks` and
  // `repetitions` in a Markdown sentence are English, and proposing a rename
  // against prose is the noise this whole design exists to avoid.
  if (isText && !rel.startsWith(TOOL_DIR)) {
    for (const [from, rename] of subpathRenames) {
      if (!inAllowedPaths(rel, rename.paths)) continue;
      // A WHOLE subpath: `@mcpjam/sdk/predicates-legacy` and
      // `@mcpjam/sdk/predicates/deep` are different modules, and proposing to
      // rename them would be proposing to break them.
      const token = new RegExp(
        `${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`,
        "g"
      );
      // One row per occurrence, not per line: a manifest line can name the
      // same subpath twice, and the report says every occurrence is listed.
      lines.forEach((lineText, index) => {
        const count = [...lineText.matchAll(token)].length;
        for (let i = 0; i < count; i += 1) {
          record(rel, index + 1, lineText, rename, from, "text reference");
        }
      });
    }
  }

  for (const rename of flagRenames) {
    if (!inAllowedPaths(rel, rename.paths)) continue;
    // A whole flag token, not a substring: `--repetitions-old` is a different
    // flag, and proposing to rename it would be proposing to break it. The
    // trailing class accepts `--repetitions` alone and `--repetitions=3`.
    const flag = new RegExp(
      `${rename.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
      "g"
    );
    // One row per occurrence: help text often names the flag twice on a line.
    lines.forEach((lineText, index) => {
      const count = [...lineText.matchAll(flag)].length;
      for (let i = 0; i < count; i += 1) {
        record(rel, index + 1, lineText, rename, rename.from, "flag token");
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
  for (const entry of unreadable) {
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
  const payload = JSON.stringify(
    {
      status: violations.length > 0 ? "protected" : "ok",
      root: ROOT,
      enumeration,
      scanned,
      skipped,
      findings,
      reviewByHand,
      outsideMapping,
      excludedByRule,
      violations,
    },
    null,
    2
  );
  // Wait for the write to drain. `process.exit` straight after an asynchronous
  // stdout write truncates piped output at the pipe buffer, 65,536 bytes on
  // macOS, and leaves a consumer of `--json` holding invalid JSON.
  await new Promise((done) => process.stdout.write(`${payload}\n`, done));
  process.exit(violations.length > 0 ? 2 : 0);
}

if (violations.length > 0) {
  console.error(
    `\nThe mapping proposes to mutate ${violations.length} protected occurrence(s). ` +
      `No report was written.\n`
  );
  for (const v of violations) {
    const where = v.file === null ? "mapping.json" : `${v.file}:${v.line}`;
    console.error(`  ✗ ${where}  ${v.from} → ${v.to}  (${v.reason})`);
    console.error(`      ${v.text}`);
  }
  if (violations.some((v) => v.reason.startsWith("protected"))) {
    console.error(
      `\nThese words mean something else — GitHub check runs, OAuth conformance, ` +
        `SAML assertions, billing trials, the evaluator-ERROR family. Narrow the ` +
        `mapping's \`paths\`, or take the occurrence out of scope. Do not widen ` +
        `protected.json to make this pass.\n`
    );
  }
  if (violations.some((v) => !v.reason.startsWith("protected"))) {
    console.error(
      `\nA rename onto a name its files still use merges two fields into one. ` +
        `Rename the existing field to an explicit legacy name first, and mark ` +
        `the dependent rename \`"after"\` it.\n`
    );
  }
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
    } file(s), from ${scanned} scanned. Every occurrence is listed below; the ` +
    `tables are not truncated.`
);
out.push("");
out.push(
  `The contract these renames implement is \`docs/evals-vocabulary-consolidation.md\`, which lands ` +
    `in the Wave 0 pull request and may not be in the tree you are reading this from. Anything not ` +
    `listed there is out of scope for this program.`
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

if (outsideMapping.length > 0) {
  const live = outsideMapping.filter((entry) => !entry.frozen);
  out.push(
    `Outside the mapping: ${live.length} more occurrence(s) across ${
      new Set(live.map((entry) => entry.file)).size
    } file(s) still spell a renamed field and are not proposed, plus ${
      outsideMapping.length - live.length
    } frozen. They are listed at the end.`
  );
  out.push("");
}

if (excludedByRule.length > 0) {
  out.push(
    `Set aside by a mapping rule: ${excludedByRule.length} occurrence(s) on lines the ` +
      `mapping marks as another meaning of the word. They are listed at the end.`
  );
  out.push("");
}

if (skipped.length > 0) {
  out.push("## Skipped");
  out.push("");
  out.push(
    `${skipped.length} listed path(s) were not read because they hold no source of their own.`
  );
  out.push("");
  out.push("| path | why |");
  out.push("|---|---|");
  for (const entry of skipped) {
    out.push(`| \`${entry.file}\` | ${entry.reason} |`);
  }
  out.push("");
}

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
  for (const entry of reviewByHand) {
    out.push(
      `| \`${entry.file}:${entry.line}\` | \`${entry.from} → ${
        entry.to
      }\` | ${entry.nearby.map((n) => `\`${n}\``).join(", ")} |`
    );
  }
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
  const first = rename?.after
    ? mapping.renames.find((r) => r.from === rename.after)
    : undefined;
  if (first) {
    out.push(`> Lands after \`${first.from} → ${first.to}\`.`);
    out.push("");
  }
  out.push("| file:line | shape | line |");
  out.push("|---|---|---|");
  // Every occurrence, not the first N. A truncated list under a stated count
  // is the worst of both: it reads as the inventory while the renames it
  // cannot locate are exactly the ones nobody will find by hand.
  for (const entry of entries) {
    out.push(
      `| \`${entry.file}:${entry.line}\` | ${entry.shape ?? "—"} | ${codeCell(
        entry.text
      )} |`
    );
  }
  out.push("");
}

const outsideByRename = new Map();
for (const entry of outsideMapping) {
  const key = `${entry.from} → ${entry.to}`;
  if (!outsideByRename.has(key)) outsideByRename.set(key, []);
  outsideByRename.get(key).push(entry);
}
for (const [key, entries] of outsideByRename) {
  const frozen = entries.filter((entry) => entry.frozen).length;
  out.push(`## Outside the mapping: \`${key}\``);
  out.push("");
  out.push(
    `> Not proposed. ${
      entries.length - frozen
    } occurrence(s) outside this rename's \`paths\` ` +
      `still spell \`${entries[0].from}\`, and ${frozen} are frozen hash-payload keys that ` +
      `never move. The rename is not done until the rest are triaged. They are listed rather ` +
      `than proposed because widening \`paths\` reaches files where \`${entries[0].to}\` ` +
      `already names something else, and the scanner refuses that merge.`
  );
  out.push("");
  out.push("| file:line | shape | frozen | line |");
  out.push("|---|---|---|---|");
  for (const entry of entries) {
    out.push(
      `| \`${entry.file}:${entry.line}\` | ${entry.shape} | ${
        entry.frozen ? "yes" : ""
      } | ${codeCell(entry.text)} |`
    );
  }
  out.push("");
}

if (excludedByRule.length > 0) {
  out.push("## Set aside by a mapping rule");
  out.push("");
  out.push(
    "> Not proposed. Each row matched its rename's `notOnLinesContaining` rule, a " +
      "reviewed claim that the word means something else on that line. A wrong rule " +
      "hides a real rename, so check these the same way as the proposals."
  );
  out.push("");
  out.push("| file:line | rename | rule | line |");
  out.push("|---|---|---|---|");
  for (const entry of excludedByRule) {
    out.push(
      `| \`${entry.file}:${entry.line}\` | \`${entry.from} → ${
        entry.to
      }\` | ${codeCell(entry.rule)} | ${codeCell(entry.text)} |`
    );
  }
  out.push("");
}

console.log(out.join("\n"));
