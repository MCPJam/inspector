#!/usr/bin/env node
/**
 * Sync docs/style.css from design-system/src/tokens.css so the Mintlify
 * site tracks the product palette automatically.
 *
 * Why a script and not @import: Mintlify's CSS pipeline can't resolve
 * package paths, and tokens.css uses Tailwind v4 directives that only
 * compile in the inspector's build. So we mirror the OKLCH values into
 * a fenced block in docs/style.css and keep it in lock-step here.
 *
 * Usage:
 *   node scripts/sync-docs-tokens.mjs           # rewrite docs/style.css
 *   node scripts/sync-docs-tokens.mjs --check   # exit 1 if drift (CI)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TOKENS = resolve(ROOT, "design-system/src/tokens.css");
const STYLE = resolve(ROOT, "docs/style.css");

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

// Soft-alpha overlay derived from --primary. Alpha differs per mode so the
// orange wash reads at the same perceived weight on cream vs warm-dark.
const ORANGE_SOFT_ALPHA = { light: "0.10", dark: "0.14" };

function extractBlock(css, selector) {
  // Matches `selector { … }` at top level, non-greedy.
  const re = new RegExp(
    String.raw`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*\{([\s\S]*?)\n\}`,
    "m",
  );
  const m = css.match(re);
  if (!m) throw new Error(`Could not locate ${selector} block in tokens.css`);
  return m[1];
}

function parseVars(block) {
  const out = new Map();
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

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
    const value = tokenVars.get(source);
    if (!value) throw new Error(`Token ${source} missing from tokens.css ${label}`);
    lines.push(`  ${`${alias}:`.padEnd(26, " ")} ${value};`);
  }
  const orange = tokenVars.get("--primary");
  lines.push(`  ${"--mcj-orange-soft:".padEnd(26, " ")} ${deriveOrangeSoft(orange, alpha)};`);

  // Code-syntax palette — derived from --code-* tokens, exposed to
  // Mintlify Shiki via --mint-* vars.
  lines.push("");
  lines.push("  /* code syntax (Mintlify Shiki) */");
  for (const [mintVar, codeVar] of Object.entries(CODE_MAP)) {
    const value = tokenVars.get(codeVar);
    if (!value) {
      throw new Error(`Token ${codeVar} missing from tokens.css ${label}`);
    }
    lines.push(`  ${`${mintVar}:`.padEnd(34, " ")} ${value};`);
  }

  lines.push("}");
  return lines.join("\n");
}

function main() {
  const check = process.argv.includes("--check");

  const tokensCss = readFileSync(TOKENS, "utf8");
  const styleCss = readFileSync(STYLE, "utf8");

  const lightVars = parseVars(extractBlock(tokensCss, ":root"));
  const darkVars = parseVars(extractBlock(tokensCss, ".dark"));

  // Dark block in tokens.css redefines only the deltas — fall back to light
  // for any var dark didn't override (e.g. --radius).
  for (const [k, v] of lightVars) if (!darkVars.has(k)) darkVars.set(k, v);

  const generated = [
    BEGIN,
    "/* Mirrors design-system/src/tokens.css — edits here will be overwritten. */",
    buildBlock("light", ":root", lightVars, ORANGE_SOFT_ALPHA.light),
    "",
    buildBlock(
      "dark",
      `.dark, [data-theme="dark"]`,
      darkVars,
      ORANGE_SOFT_ALPHA.dark,
    ),
    END,
  ].join("\n");

  const fence = new RegExp(
    `${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`,
    "m",
  );

  if (!fence.test(styleCss)) {
    throw new Error(
      `Could not find generated fence in ${STYLE}. ` +
        `Add the BEGIN/END markers before running this script.`,
    );
  }

  const next = styleCss.replace(fence, generated);

  if (check) {
    if (next !== styleCss) {
      console.error(
        "docs/style.css is out of sync with design-system/src/tokens.css.\n" +
          "Run: npm run docs:sync-tokens",
      );
      process.exit(1);
    }
    console.log("docs/style.css is in sync with design-system tokens.");
    return;
  }

  if (next === styleCss) {
    console.log("docs/style.css already in sync — nothing to do.");
    return;
  }

  writeFileSync(STYLE, next);
  console.log("docs/style.css updated from design-system tokens.");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main();
