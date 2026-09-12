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

/**
 * The tool's own directory.
 *
 * `mapping.json` names every subpath this program renames and `REPORT.md`
 * quotes them back, so a text scan that included them would report the
 * instructions as work. They are not rename sites; they are the tool.
 */
const TOOL_DIR = "scripts/codemod/evals-vocabulary/";

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

  const visit = (node) => {
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
      const isShorthand =
        (inObjectBinding && !parent.propertyName && parent.name === node) ||
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
      // A file the parser could not read — including one it "read" while
      // reporting diagnostics — is a hole in the inventory, and an inventory
      // with a hole in it is worse than no inventory: it reads as complete.
      // Fail closed.
      unreadable.push({ file: rel, reason: String(error) });
      continue;
    }

    for (const node of nodes) {
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
          if (!inAllowedPaths(rel, rename.paths)) continue;
          record(
            rel,
            line,
            lineText,
            rename,
            node.value,
            node.isField ? "field" : "field named in a string"
          );
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
        `${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`
      );
      lines.forEach((lineText, index) => {
        if (token.test(lineText)) {
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
      `${rename.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`
    );
    lines.forEach((lineText, index) => {
      if (flag.test(lineText)) {
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

console.log(out.join("\n"));
