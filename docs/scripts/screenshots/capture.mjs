#!/usr/bin/env node
// Screenshot capture harness for the MCPJam docs.
//
// Usage:
//   node docs/scripts/screenshots/capture.mjs [--only <id>] [--kind ui|terminal] [--tier A|B|C] [--list] [--validate]
//
// See docs/scripts/screenshots/README.md for the full workflow.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// docs/scripts/screenshots -> docs
const DOCS_ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(__dirname, "manifest.json");

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";
const STORAGE_STATE = process.env.STORAGE_STATE || null;

const VALID_KINDS = new Set(["ui", "terminal"]);
const VALID_TIERS = new Set(["A", "B", "C"]);

function parseArgs(argv) {
  const opts = {
    only: null,
    kind: null,
    tier: null,
    list: false,
    validate: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--only":
        opts.only = argv[++i];
        if (!opts.only) {
          throw new Error("--only requires an id argument");
        }
        break;
      case "--kind":
        opts.kind = argv[++i];
        if (!VALID_KINDS.has(opts.kind)) {
          throw new Error(`--kind must be one of ui|terminal (got: ${opts.kind})`);
        }
        break;
      case "--tier":
        opts.tier = argv[++i];
        if (!VALID_TIERS.has(opts.tier)) {
          throw new Error(`--tier must be one of A|B|C (got: ${opts.tier})`);
        }
        break;
      case "--list":
        opts.list = true;
        break;
      case "--validate":
        opts.validate = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function loadManifest() {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw);
  if (!Array.isArray(manifest.entries)) {
    throw new Error("manifest.json is missing an entries array");
  }
  return manifest;
}

function filterEntries(entries, opts) {
  return entries.filter((entry) => {
    if (opts.only && entry.id !== opts.only) return false;
    if (opts.kind && entry.kind !== opts.kind) return false;
    if (opts.tier && entry.tier !== opts.tier) return false;
    return true;
  });
}

// Checks the whole manifest (not just the filtered subset) so id collisions
// and structural problems are always caught, regardless of which entries
// were selected for this run.
function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  const seenIds = new Set();

  for (const entry of manifest.entries) {
    const label = entry.id || "<missing id>";

    if (!entry.id) {
      errors.push(`${label}: missing id`);
    } else if (seenIds.has(entry.id)) {
      errors.push(`${label}: duplicate id`);
    } else {
      seenIds.add(entry.id);
    }

    if (!VALID_KINDS.has(entry.kind)) {
      errors.push(`${label}: kind must be "ui" or "terminal" (got: ${entry.kind})`);
    }

    if (!entry.page) {
      errors.push(`${label}: missing page`);
    } else {
      const pagePath = path.join(DOCS_ROOT, entry.page);
      if (!existsSync(pagePath)) {
        errors.push(`${label}: page file not found: ${entry.page}`);
      }
    }

    if (!entry.output) {
      errors.push(`${label}: missing output`);
    } else if (!entry.output.startsWith("docs/images/")) {
      errors.push(`${label}: output must be under docs/images/ (got: ${entry.output})`);
    }

    if (!entry.alt) {
      errors.push(`${label}: missing alt text`);
    } else if (/screenshot/i.test(entry.alt)) {
      errors.push(`${label}: alt text must not contain the word "screenshot"`);
    } else if (entry.alt.includes(String.fromCharCode(0x2014))) {
      errors.push(`${label}: alt text must not contain an em-dash`);
    }

    if (entry.kind === "ui") {
      if (!entry.route) {
        errors.push(`${label}: ui entries require a route`);
      } else if (entry.route.includes("TODO-resolve")) {
        warnings.push(`${label}: route contains an unresolved TODO-resolve placeholder: ${entry.route}`);
      }
    }

    if (entry.kind === "terminal" && !entry.command) {
      errors.push(`${label}: terminal entries require a command`);
    }
  }

  return { errors, warnings };
}

function printList(entries) {
  for (const entry of entries) {
    const tier = entry.tier ? ` tier=${entry.tier}` : "";
    console.log(`${entry.id}\t${entry.kind}${tier}\t${entry.output}`);
  }
}

async function captureUi(entry, { browser }) {
  throw new Error("not implemented yet");
}

async function captureTerminal(entry, { browser }) {
  throw new Error("not implemented yet");
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const manifest = loadManifest();
  const selected = filterEntries(manifest.entries, opts);

  if (opts.list) {
    printList(selected);
    return;
  }

  if (opts.validate) {
    const { errors, warnings } = validateManifest(manifest);
    for (const warning of warnings) {
      console.warn(`WARN: ${warning}`);
    }
    if (errors.length > 0) {
      console.error(`manifest INVALID (${errors.length} error(s)):`);
      for (const error of errors) {
        console.error(`  - ${error}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`manifest OK (${manifest.entries.length} entries)`);
    return;
  }

  if (selected.length === 0) {
    console.error("No manifest entries matched the given filters.");
    process.exitCode = 1;
    return;
  }

  console.log(`Base URL: ${BASE_URL}`);
  if (STORAGE_STATE) {
    console.log(`Storage state: ${STORAGE_STATE}`);
  }

  // Playwright wiring lands in later tasks; the browser handle is left null
  // here on purpose so captureUi/captureTerminal can be implemented without
  // touching this dispatch loop.
  const browser = null;

  let ok = 0;
  let failed = 0;

  for (const entry of selected) {
    try {
      if (entry.kind === "ui") {
        await captureUi(entry, { browser });
      } else if (entry.kind === "terminal") {
        await captureTerminal(entry, { browser });
      } else {
        throw new Error(`unknown kind: ${entry.kind}`);
      }
      console.log(`ok    ${entry.id}`);
      ok++;
    } catch (err) {
      console.error(`fail  ${entry.id}: ${err.message}`);
      failed++;
    }
  }

  console.log(`${ok} ok, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
