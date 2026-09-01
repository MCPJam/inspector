#!/usr/bin/env node
/**
 * Generate DESIGN.md's YAML front matter from design-system/src/tokens.css.
 *
 * WHY THIS EXISTS. DESIGN.md describes the MCPJam design system to coding
 * agents, in the open format at github.com/google-labs-code/design.md. Half
 * of that file is judgment an agent cannot infer — why a token exists, when
 * NOT to reach for it — and that half is hand-written. The other half is the
 * palette itself, which already has a source of truth. Retyping it would
 * create a fourth hand-maintained copy of the same colors, which is the exact
 * failure this file is meant to end.
 *
 * So the front matter is generated and the prose is hand-owned, with one rule
 * that keeps them from fighting: THE PROSE NEVER STATES A LITERAL COLOR
 * VALUE, only token names. Nothing below the front matter can go stale.
 *
 * Two conventions the format itself does not cover:
 *
 *   - DARK MODE. The spec models a single palette, so every token is emitted
 *     twice: `primary` and `primary-dark`. One predictable rule beats a
 *     half-described one, so the twin is emitted for EVERY token, including
 *     the ones dark mode inherits unchanged.
 *   - SHADOWS. The schema has no elevation token group, so the shadow scale
 *     is described in the Elevation & Depth prose instead of being invented
 *     into a key the linter would ignore.
 *
 * Any token that fits neither a schema group nor the documented prose-only
 * list is a THROW, not a skip: a palette that grows a category nobody
 * described is precisely when this file needs a human.
 *
 * Bumping the pinned @google/design.md is deliberate: change the version in
 * package.json, re-read `npx designmd spec`, and adjust this generator and
 * the prose in the same PR. The format is alpha; it will move.
 *
 * Usage:
 *   node scripts/sync-design-md.mjs           # rewrite DESIGN.md front matter
 *   node scripts/sync-design-md.mjs --check   # exit 1 if drift (CI)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { readTokenModes } from "./lib/tokens-css.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TOKENS = resolve(ROOT, "design-system/src/tokens.css");
const DESIGN_MD = resolve(ROOT, "DESIGN.md");

/** Tokens deliberately described in prose rather than emitted as schema. */
const PROSE_ONLY = /^--(shadow|tracking-)/;

/**
 * Component tokens, as references only.
 *
 * These earn their place twice over. They are what an agent reads to answer
 * "what does a primary button actually look like", and — because `broken-ref`
 * is the one error-severity lint rule — they are the only thing that makes
 * the linter verify the generated color and radius maps at all. A typo in a
 * token name fails CI here rather than shipping.
 */
const COMPONENTS = {
  "button-primary": {
    backgroundColor: "{colors.primary}",
    textColor: "{colors.primary-foreground}",
    rounded: "{rounded.lg}",
    typography: "{typography.sans}",
  },
  "button-secondary": {
    backgroundColor: "{colors.secondary}",
    textColor: "{colors.secondary-foreground}",
    rounded: "{rounded.lg}",
  },
  popover: {
    backgroundColor: "{colors.popover}",
    textColor: "{colors.popover-foreground}",
    rounded: "{rounded.lg}",
  },
  "menu-item": {
    backgroundColor: "{colors.accent}",
    textColor: "{colors.accent-foreground}",
    rounded: "{rounded.sm}",
  },
  skeleton: {
    backgroundColor: "{colors.muted}",
    rounded: "{rounded.md}",
  },
  "button-destructive": {
    backgroundColor: "{colors.destructive}",
    textColor: "{colors.destructive-foreground}",
    rounded: "{rounded.lg}",
  },
  card: {
    backgroundColor: "{colors.card}",
    textColor: "{colors.card-foreground}",
    rounded: "{rounded.lg}",
  },
  input: {
    backgroundColor: "{colors.background}",
    textColor: "{colors.foreground}",
    rounded: "{rounded.md}",
  },
  "badge-success": {
    backgroundColor: "{colors.success}",
    textColor: "{colors.success-foreground}",
    rounded: "{rounded.sm}",
  },
  "badge-warning": {
    backgroundColor: "{colors.warning}",
    textColor: "{colors.warning-foreground}",
    rounded: "{rounded.sm}",
  },
  "badge-info": {
    backgroundColor: "{colors.info}",
    textColor: "{colors.info-foreground}",
    rounded: "{rounded.sm}",
  },
  "badge-pending": {
    backgroundColor: "{colors.pending}",
    textColor: "{colors.pending-foreground}",
    rounded: "{rounded.sm}",
  },
  "code-block": {
    backgroundColor: "{colors.code-bg}",
    textColor: "{colors.code-text}",
    typography: "{typography.code}",
    rounded: "{rounded.md}",
  },
};

/** `--foo-bar` -> `foo-bar`. */
const tokenName = (cssVar) => cssVar.replace(/^--/, "");

/** YAML double-quoted scalar; JSON's escapes are a subset YAML accepts. */
const yamlString = (value) => JSON.stringify(String(value));

/**
 * Sort every token in tokens.css into a schema group, or throw.
 *
 * Source order is preserved because it is meaningful: tokens.css groups core
 * roles, then status, then the specialised palettes, and an agent reading the
 * front matter benefits from the same grouping.
 */
function classify(lightVars) {
  const colors = [];
  const fonts = [];
  let radius = null;
  let spacing = null;

  for (const [cssVar, value] of lightVars) {
    if (tokenName(cssVar).endsWith("-dark")) {
      throw new Error(
        `Token ${cssVar} collides with the -dark twin convention used for dark-mode ` +
          "values in DESIGN.md. Rename the token or change the convention in this script.",
      );
    }

    if (PROSE_ONLY.test(cssVar)) continue;
    if (cssVar.startsWith("--font-")) fonts.push(cssVar);
    else if (cssVar === "--radius") radius = value;
    else if (cssVar === "--spacing") spacing = value;
    else if (value.startsWith("oklch(")) colors.push(cssVar);
    else {
      throw new Error(
        `Token ${cssVar} (${value}) fits no DESIGN.md schema group.\n` +
          "Add it to a group in scripts/sync-design-md.mjs, or to the prose-only list " +
          "and describe it in DESIGN.md.",
      );
    }
  }

  if (!radius) throw new Error("tokens.css defines no --radius");
  if (!spacing) throw new Error("tokens.css defines no --spacing");
  return { colors, fonts, radius, spacing };
}

/**
 * The `rounded` scale, derived exactly as design-system/src/index.css derives
 * its Tailwind radii (`calc(var(--radius) ± Npx)`), so the two cannot drift.
 */
function roundedScale(radius) {
  const m = radius.match(/^([\d.]+)(rem|px)$/);
  if (!m) throw new Error(`Cannot derive a radius scale from --radius: ${radius}`);
  const unit = m[2];
  const perUnit = unit === "rem" ? 16 : 1;
  const basePx = parseFloat(m[1]) * perUnit;

  const format = (px) => {
    const n = px / perUnit;
    return `${Number(n.toFixed(4))}${unit}`;
  };

  return {
    sm: format(basePx - 4),
    md: format(basePx - 2),
    lg: format(basePx),
    xl: format(basePx + 4),
  };
}

function buildFrontMatter(modes) {
  const { colors, fonts, radius, spacing } = classify(modes.light);
  const rounded = roundedScale(radius);

  const lines = [
    "---",
    "# GENERATED FROM design-system/src/tokens.css — DO NOT EDIT.",
    "# Run: npm run design:sync",
    "#",
    "# Dark mode is not part of the DESIGN.md schema, so every color token",
    "# below has exactly one `-dark` twin holding its dark-mode value.",
    "version: alpha",
    'name: "MCPJam"',
    'description: "Design system for the MCPJam MCP inspector, docs, and embedded surfaces."',
    "",
    "colors:",
  ];

  for (const cssVar of colors) {
    lines.push(`  ${tokenName(cssVar)}: ${yamlString(modes.light.get(cssVar))}`);
  }
  lines.push("");
  for (const cssVar of colors) {
    lines.push(`  ${tokenName(cssVar)}-dark: ${yamlString(modes.dark.get(cssVar))}`);
  }

  lines.push("", "typography:");
  for (const cssVar of fonts) {
    lines.push(`  ${tokenName(cssVar).replace(/^font-/, "")}:`);
    lines.push(`    fontFamily: ${yamlString(modes.light.get(cssVar))}`);
  }

  lines.push("", "rounded:");
  for (const [level, value] of Object.entries(rounded)) {
    lines.push(`  ${level}: ${value}`);
  }

  lines.push("", "spacing:", `  base: ${spacing}`);

  lines.push("", "components:");
  for (const [component, props] of Object.entries(COMPONENTS)) {
    lines.push(`  ${component}:`);
    for (const [prop, ref] of Object.entries(props)) {
      lines.push(`    ${prop}: ${yamlString(ref)}`);
    }
  }

  lines.push("---");
  return lines.join("\n");
}

function nextDesignMd(current, modes) {
  const fence = /^---\n([\s\S]*?\n)?---/;
  if (!fence.test(current)) {
    throw new Error(
      `Could not find the YAML front matter fence at the top of ${DESIGN_MD}. ` +
        "The file must open with a --- delimited block for this script to own.",
    );
  }
  return current.replace(fence, buildFrontMatter(modes));
}

function main() {
  const check = process.argv.includes("--check");
  const modes = readTokenModes(TOKENS);
  const current = readFileSync(DESIGN_MD, "utf8");
  const next = nextDesignMd(current, modes);

  if (check) {
    if (next !== current) {
      console.error(
        "DESIGN.md front matter is out of sync with design-system/src/tokens.css.\n" +
          "Run: npm run design:sync",
      );
      process.exit(1);
    }
    console.log("DESIGN.md front matter is in sync with design-system tokens.");
    return;
  }

  if (next === current) {
    console.log("DESIGN.md already in sync — nothing to do.");
    return;
  }

  writeFileSync(DESIGN_MD, next);
  console.log("DESIGN.md front matter updated from design-system tokens.");
}

main();
