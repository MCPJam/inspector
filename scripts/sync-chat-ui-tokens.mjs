#!/usr/bin/env node
/**
 * Sync @mcpjam/chat-ui's package-owned token values from
 * design-system/src/tokens.css.
 *
 * WHY THIS EXISTS. chat-ui renders with shadcn-style semantic utilities
 * (`bg-card`, `text-muted-foreground`, …) whose values come from the host
 * app. Hosts that have not defined those tokens still need a readable
 * transcript, so the package ships defaults scoped to `.mcpjam-chat-ui`.
 * Those defaults were transcribed by hand from stock shadcn and stayed
 * there — generic neutral zinc, while the product moved to warm paper and
 * brown ink. An embedder following our own docs got a transcript that did
 * not look like MCPJam.
 *
 * Only the VALUES are generated. The selector architecture around them is
 * load-bearing and hand-owned: `.dark .mcpjam-chat-ui.light` is what lets a
 * forced-light transcript survive inside a dark host, and no palette sync
 * should be able to disturb it. The `--trace-waterfall-*` rules further down
 * are likewise untouched — they are chat-ui's own port of the inspector's
 * waterfall styling, not core palette tokens.
 *
 * Values are emitted as HSL channel triplets because that is what
 * `hsl(var(--token))` consumers expect; the source of truth stays OKLCH.
 *
 * Usage:
 *   node scripts/sync-chat-ui-tokens.mjs           # rewrite chat-ui/src/styles.css
 *   node scripts/sync-chat-ui-tokens.mjs --check   # exit 1 if drift (CI)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  oklchToHslTriplet,
  readTokenModes,
  requireToken,
} from "./lib/tokens-css.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TOKENS = resolve(ROOT, "design-system/src/tokens.css");
const STYLES = resolve(ROOT, "chat-ui/src/styles.css");

/*
 * The two rulesets this script owns, and the selector chain each carries.
 *
 * The selectors live here rather than in the stylesheet's fenced region
 * because the region is rewritten wholesale; keeping them beside the mode
 * they serve is what makes the light/dark override chain reviewable in one
 * place.
 */
const MODES = [
  {
    label: "light",
    mode: "light",
    selectors: [".mcpjam-chat-ui", ".mcpjam-chat-ui.light", ".dark .mcpjam-chat-ui.light"],
  },
  {
    label: "dark",
    mode: "dark",
    selectors: [".mcpjam-chat-ui.dark", ".dark .mcpjam-chat-ui:not(.light)"],
  },
];

/*
 * Which product tokens the transcript declares, in emission order.
 *
 * Grouped so the trace-timeline note survives regeneration: it records WHY
 * seven of these exist at all, which is the first question a reader of the
 * generated block would otherwise ask.
 */
const TOKEN_GROUPS = [
  {
    comment: null,
    tokens: [
      "--background",
      "--foreground",
      "--card",
      "--card-foreground",
      "--muted",
      "--muted-foreground",
      "--border",
      "--destructive",
      "--destructive-foreground",
    ],
  },
  {
    comment: "Trace-timeline-only tokens (popover tooltip, focus ring, warning badge).",
    tokens: [
      "--popover",
      "--popover-foreground",
      "--accent",
      "--accent-foreground",
      "--ring",
      "--warning",
      "--warning-foreground",
    ],
  },
];

function buildRuleset({ label, mode, selectors }, modes) {
  const lines = [`${selectors.join(",\n")} {`];
  for (const group of TOKEN_GROUPS) {
    if (group.comment) lines.push(`  /* ${group.comment} */`);
    for (const token of group.tokens) {
      const value = oklchToHslTriplet(requireToken(modes[mode], token, label));
      lines.push(`  ${token}: ${value};`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}

function nextStyles(css, modes) {
  let next = css;

  for (const spec of MODES) {
    const begin = `/* BEGIN GENERATED: ${spec.label} — sync via \`npm run chatui:sync-tokens\` */`;
    const end = `/* END GENERATED: ${spec.label} */`;
    const fence = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}`, "m");

    if (!fence.test(next)) {
      throw new Error(
        `Could not find the ${spec.label} generated fence in ${STYLES}. ` +
          "Add the BEGIN/END markers before running this script.",
      );
    }

    next = next.replace(fence, [begin, buildRuleset(spec, modes), end].join("\n"));
  }

  return next;
}

function main() {
  const check = process.argv.includes("--check");
  const modes = readTokenModes(TOKENS);
  const current = readFileSync(STYLES, "utf8");
  const next = nextStyles(current, modes);

  if (check) {
    if (next !== current) {
      console.error(
        "chat-ui/src/styles.css is out of sync with design-system/src/tokens.css.\n" +
          "Run: npm run chatui:sync-tokens",
      );
      process.exit(1);
    }
    console.log("chat-ui/src/styles.css is in sync with design-system tokens.");
    return;
  }

  if (next === current) {
    console.log("chat-ui/src/styles.css already in sync — nothing to do.");
    return;
  }

  writeFileSync(STYLES, next);
  console.log("chat-ui/src/styles.css updated from design-system tokens.");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main();
