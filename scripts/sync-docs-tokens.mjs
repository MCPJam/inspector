#!/usr/bin/env node
/**
 * Sync the Mintlify docs surface from design-system/src/tokens.css so the
 * docs site tracks the product palette automatically.
 *
 * Why a script and not @import: Mintlify's CSS pipeline can't resolve
 * package paths, and tokens.css uses Tailwind v4 directives that only
 * compile in the inspector's build. So we mirror the OKLCH values into
 * a fenced block in docs/style.css and keep it in lock-step here.
 *
 * Two targets, one source:
 *
 *   - docs/style.css — the fenced `:root` / `.dark` custom-property block
 *     that the hand-written rules below it consume.
 *   - docs.json — Mintlify's own theme fields, which accept only literal
 *     hex. Those five values were hand-picked once and then drifted from the
 *     product palette with nothing to catch it; they are derived now.
 *
 * Usage:
 *   node scripts/sync-docs-tokens.mjs           # rewrite both files
 *   node scripts/sync-docs-tokens.mjs --check   # exit 1 if drift (CI)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  oklchToHex,
  readTokenModes,
  requireToken,
} from "./lib/tokens-css.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TOKENS = resolve(ROOT, "design-system/src/tokens.css");
const STYLE = resolve(ROOT, "docs/style.css");
const DOCS_JSON = resolve(ROOT, "docs/docs.json");

const BEGIN = "/* BEGIN GENERATED — sync via `npm run docs:sync-tokens` */";
const END = "/* END GENERATED */";

// docs-alias ← product-token
// Hand-curated; reflects what docs/style.css actually consumes.
const MAP = {
  "--mcj-paper":       "--background",
  "--mcj-paper-2":     "--muted",
  "--mcj-paper-3":     "--accent",
  "--mcj-ink":         "--foreground",
  "--mcj-ink-strong":  "--card-foreground",
  "--mcj-ink-muted":   "--muted-foreground",
  "--mcj-rule":        "--border",
  "--mcj-rule-strong": "--input",
  "--mcj-orange":      "--primary",
  "--mcj-orange-edge": "--ring",
  "--mcj-radius":      "--radius",
};

// Mintlify Shiki vars ← design-system code-syntax tokens. Activated by
// docs.json `styling.codeblocks.theme = "css-variables"`. Mintlify maps
// object-property names to `keyword`, so the property-key color is
// effectively shared with keywords; we set `keyword` to --code-keyword
// and accept that compromise (one accent for both is the Anthropic-ish
// look anyway).
const CODE_MAP = {
  "--mint-color-text":              "--code-text",
  "--mint-color-background":        "--code-bg",
  "--mint-token-keyword":           "--code-keyword",
  "--mint-token-function":          "--code-function",
  "--mint-token-string":            "--code-string",
  "--mint-token-string-expression": "--code-string",
  "--mint-token-constant":          "--code-number",
  "--mint-token-parameter":         "--code-parameter",
  "--mint-token-punctuation":       "--code-punctuation",
  "--mint-token-comment":           "--code-comment",
  "--mint-token-link":              "--code-link",
};

/*
 * docs.json theme field ← the token that defines it.
 *
 * Mintlify's three brand fields are one color at three weights: `primary` is
 * the brand orange, `dark` is the weight that survives on a light page, and
 * `light` is the weight that survives on a dark one. The palette already
 * names all three — `--ring` is the darker "orange edge" the docs CSS
 * already borrows as `--mcj-orange-edge`, and dark mode's `--code-link` is
 * the brand orange lifted for dark surfaces — so nothing here is invented.
 */
const DOCS_JSON_MAP = [
  { path: ["colors", "primary"],           token: "--primary",    mode: "light" },
  { path: ["colors", "dark"],              token: "--ring",       mode: "light" },
  { path: ["colors", "light"],             token: "--code-link",  mode: "dark"  },
  { path: ["background", "color", "light"], token: "--background", mode: "light" },
  { path: ["background", "color", "dark"],  token: "--background", mode: "dark"  },
];

// Soft-alpha overlay derived from --primary. Alpha differs per mode so the
// orange wash reads at the same perceived weight on cream vs warm-dark.
const ORANGE_SOFT_ALPHA = { light: "0.10", dark: "0.14" };

function deriveOrangeSoft(primaryValue, alpha) {
  // primaryValue is e.g. `oklch(0.6832 0.1382 38.744)` — splice alpha in.
  const m = primaryValue.match(/^oklch\(\s*([^)]+?)\s*\)$/i);
  if (!m) throw new Error(`Cannot derive orange-soft from ${primaryValue}`);
  return `oklch(${m[1]} / ${alpha})`;
}

function buildBlock(label, selectorChain, tokenVars, alpha) {
  const lines = [`${selectorChain} {`];

  // Surface palette (page chrome, borders, etc.)
  for (const [alias, source] of Object.entries(MAP)) {
    const value = requireToken(tokenVars, source, label);
    lines.push(`  ${`${alias}:`.padEnd(26, " ")} ${value};`);
  }
  const orange = tokenVars.get("--primary");
  lines.push(`  ${"--mcj-orange-soft:".padEnd(26, " ")} ${deriveOrangeSoft(orange, alpha)};`);

  // Code-syntax palette — derived from --code-* tokens, exposed to
  // Mintlify Shiki via --mint-* vars.
  lines.push("");
  lines.push("  /* code syntax (Mintlify Shiki) */");
  for (const [mintVar, codeVar] of Object.entries(CODE_MAP)) {
    const value = requireToken(tokenVars, codeVar, label);
    lines.push(`  ${`${mintVar}:`.padEnd(34, " ")} ${value};`);
  }

  lines.push("}");
  return lines.join("\n");
}

/** Rewrite docs/style.css's fenced block; returns the new file contents. */
function nextStyleCss(styleCss, modes) {
  const generated = [
    BEGIN,
    "/* Mirrors design-system/src/tokens.css — edits here will be overwritten. */",
    buildBlock("light", ":root", modes.light, ORANGE_SOFT_ALPHA.light),
    "",
    buildBlock(
      "dark",
      `.dark, [data-theme="dark"]`,
      modes.dark,
      ORANGE_SOFT_ALPHA.dark,
    ),
    END,
  ].join("\n");

  const fence = new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`, "m");

  if (!fence.test(styleCss)) {
    throw new Error(
      `Could not find generated fence in ${STYLE}. ` +
        `Add the BEGIN/END markers before running this script.`,
    );
  }

  return styleCss.replace(fence, generated);
}

/**
 * Index of the closing quote of the JSON string starting at `i`.
 *
 * Escape handling is by SKIPPING the escaped character rather than by looking
 * back one byte: `"a\\\\"` ends at a quote whose predecessor is a backslash, and a
 * look-back test reads that valid terminator as escaped and runs off the end of
 * the value.
 */
function endOfString(raw, i) {
  for (let j = i + 1; j < raw.length; j++) {
    if (raw[j] === "\\") {
      j++;
      continue;
    }
    if (raw[j] === '"') return j;
  }
  throw new Error("Unterminated string in docs.json");
}

/** Body span (inside the braces) of the object literal starting at `at`. */
function objectBodyAt(raw, at) {
  if (raw[at] !== "{") return null;
  let depth = 0;
  for (let i = at; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      i = endOfString(raw, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return { start: at + 1, end: i };
  }
  throw new Error("Unterminated object in docs.json");
}

/**
 * Find `key` among the DIRECT children of the object body `body`.
 *
 * Depth tracking is the point. A regex scan for `"colors"\s*:\s*\{` matches the
 * FIRST such text in range, which may belong to a nested object — and then the
 * edit lands on the wrong field while `JSON.parse` still succeeds, so nothing
 * downstream notices. Only a direct child may match.
 *
 * The `:` check is what separates a key from a string value that happens to
 * read like one.
 */
function findChild(raw, body, key) {
  let depth = 0;
  for (let i = body.start; i < body.end; i++) {
    const ch = raw[i];
    if (ch === '"') {
      const close = endOfString(raw, i);
      if (depth === 0 && raw.slice(i + 1, close) === key) {
        let j = close + 1;
        while (j < body.end && /\s/.test(raw[j])) j++;
        if (raw[j] === ":") {
          j++;
          while (j < body.end && /\s/.test(raw[j])) j++;
          return { valueStart: j };
        }
      }
      i = close;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return null;
}

/** Replace one `"key": "value"` string field, leaving all other bytes alone. */
function setStringField(raw, path, value) {
  let body = objectBodyAt(raw, raw.indexOf("{"));
  if (!body) throw new Error("docs.json does not open with a JSON object.");

  for (const key of path.slice(0, -1)) {
    const child = findChild(raw, body, key);
    if (!child) {
      throw new Error(`docs.json has no "${key}" object (deriving ${path.join(".")})`);
    }
    body = objectBodyAt(raw, child.valueStart);
    if (!body) {
      throw new Error(`docs.json field "${key}" is not an object (deriving ${path.join(".")})`);
    }
  }

  const leaf = findChild(raw, body, path.at(-1));
  if (!leaf || raw[leaf.valueStart] !== '"') {
    throw new Error(`docs.json has no "${path.join(".")}" string field to derive.`);
  }

  const close = endOfString(raw, leaf.valueStart);
  return raw.slice(0, leaf.valueStart) + JSON.stringify(value) + raw.slice(close + 1);
}

/**
 * Rewrite docs.json's derived color fields; returns the new file contents.
 *
 * Everything else in the file — key order, spacing, the hand-collapsed page
 * arrays — is preserved byte for byte, so `--check` fails on a drifted color
 * and on nothing else.
 */
function nextDocsJson(docsJsonRaw, modes) {
  let next = docsJsonRaw;
  for (const { path, token, mode } of DOCS_JSON_MAP) {
    next = setStringField(next, path, oklchToHex(requireToken(modes[mode], token, mode)));
  }

  // The edits are textual; parsing the result is what proves they were not.
  JSON.parse(next);
  return next;
}

/*
 * Import-time self-check for the two properties that make the edit safe.
 *
 * Both were wrong in the first version of this script and neither was caught
 * by `JSON.parse`: a regex scan matched a nested object's key and edited the
 * wrong field, and a look-back escape test mis-read a value ending in a
 * backslash. Silent corruption of the right-looking shape is exactly what a
 * downstream parse cannot detect, so the invariants are asserted here.
 */
for (const [label, raw, path, expect] of [
  [
    "direct children only",
    '{"outer":{"colors":{"primary":"nested"}},"colors":{"primary":"target"}}',
    ["colors", "primary"],
    (doc) => doc.outer.colors.primary === "nested" && doc.colors.primary === "X",
  ],
  [
    "backslash-terminated values",
    '{"colors":{"a":"t\\\\","primary":"target"}}',
    ["colors", "primary"],
    (doc) => doc.colors.a === "t\\" && doc.colors.primary === "X",
  ],
]) {
  if (!expect(JSON.parse(setStringField(raw, path, "X")))) {
    throw new Error(`sync-docs-tokens.mjs JSON walker is wrong: ${label}`);
  }
}

function main() {
  const check = process.argv.includes("--check");
  const modes = readTokenModes(TOKENS);

  const targets = [
    { path: STYLE, label: "docs/style.css", current: readFileSync(STYLE, "utf8"), build: nextStyleCss },
    { path: DOCS_JSON, label: "docs/docs.json", current: readFileSync(DOCS_JSON, "utf8"), build: nextDocsJson },
  ].map((t) => ({ ...t, next: t.build(t.current, modes) }));

  const drifted = targets.filter((t) => t.next !== t.current);

  if (check) {
    if (drifted.length > 0) {
      console.error(
        `${drifted.map((t) => t.label).join(" and ")} out of sync with ` +
          "design-system/src/tokens.css.\nRun: npm run docs:sync-tokens",
      );
      process.exit(1);
    }
    console.log("docs/style.css and docs/docs.json are in sync with design-system tokens.");
    return;
  }

  if (drifted.length === 0) {
    console.log("docs surface already in sync — nothing to do.");
    return;
  }

  for (const target of drifted) {
    writeFileSync(target.path, target.next);
    console.log(`${target.label} updated from design-system tokens.`);
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main();
