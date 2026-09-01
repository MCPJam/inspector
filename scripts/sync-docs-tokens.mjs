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
 * Locate the `{ … }` value of `"key"` inside a region of raw JSON text.
 *
 * Brace-counting with string skipping, because the point of this whole
 * exercise is to touch five values and nothing else: re-serializing the
 * document would reflow every hand-formatted array in docs.json and bury the
 * palette change in hundreds of lines of unrelated churn.
 */
function findObjectRegion(raw, key, region) {
  const keyRe = new RegExp(`"${key}"\\s*:\\s*\\{`, "g");
  keyRe.lastIndex = region.start;
  const m = keyRe.exec(raw);
  if (!m || m.index >= region.end) return null;

  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < region.end; i++) {
    const ch = raw[i];
    if (ch === '"') {
      i++;
      while (i < region.end && !(raw[i] === '"' && raw[i - 1] !== "\\")) i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return { start: m.index, end: i + 1 };
  }
  return null;
}

/** Replace one `"key": "value"` string field inside a region, in place. */
function setStringField(raw, path, value) {
  let region = { start: 0, end: raw.length };
  for (const key of path.slice(0, -1)) {
    region = findObjectRegion(raw, key, region);
    if (!region) {
      throw new Error(`docs.json has no "${key}" object (deriving ${path.join(".")})`);
    }
  }

  const leaf = path.at(-1);
  const leafRe = new RegExp(`("${leaf}"\\s*:\\s*)"[^"]*"`);
  const slice = raw.slice(region.start, region.end);
  if (!leafRe.test(slice)) {
    throw new Error(`docs.json has no "${path.join(".")}" string field to derive.`);
  }

  return raw.slice(0, region.start) + slice.replace(leafRe, `$1"${value}"`) + raw.slice(region.end);
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
