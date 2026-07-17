#!/usr/bin/env node
// Screenshot capture harness for the MCPJam docs.
//
// Usage:
//   node docs/scripts/screenshots/capture.mjs [--only <id>] [--kind ui|terminal] [--tier A|B|C] [--list] [--validate]
//
// See docs/scripts/screenshots/README.md for the full workflow.

import { readFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// docs/scripts/screenshots -> docs
const DOCS_ROOT = path.resolve(__dirname, "..", "..");
// docs -> repo root, where the built CLI lives
const REPO_ROOT = path.resolve(DOCS_ROOT, "..");
const MANIFEST_PATH = path.join(__dirname, "manifest.json");
const TERMINAL_TEMPLATE_PATH = path.join(__dirname, "terminal.html");
const CLI_ENTRY = path.join(REPO_ROOT, "cli", "dist", "index.js");

const execFileAsync = promisify(execFileCb);

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";
const STORAGE_STATE = process.env.STORAGE_STATE || null;

const VALID_KINDS = new Set(["ui", "terminal"]);
const VALID_TIERS = new Set(["A", "B", "C"]);

// The CLI switches to JSON output when stdout isn't a TTY (which it never is
// under execFile). These ids render structured results that only look right
// in "human" format (pretty-printed), so force it for the actual capture run.
// The displayed prompt/title still show the command as a user would type it.
const FORMAT_HUMAN_IDS = new Set([
  "cli-server-doctor",
  "cli-tools-list",
  "cli-apps-conformance",
  "cli-telemetry-status",
]);

const MCP_STDIO_READY_LINE = "MCPJam MCP server listening on stdio";
const MAX_OUTPUT_LINES = 48;

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

// Strip the only ANSI the CLI ever emits: `\r\x1b[K` progress heartbeats and
// `\x1b[...m` color codes (dim/reset). There is no full terminal emulation
// here on purpose -- the CLI has no other stray control sequences.
function stripAnsi(text) {
  return text.replace(/\r\x1b\[K/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateLines(text, maxLines) {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n…`;
}

function combineOutput(stdout, stderr) {
  const parts = [];
  if (stdout && stdout.trim().length > 0) parts.push(stdout.replace(/\s+$/, ""));
  if (stderr && stderr.trim().length > 0) parts.push(stderr.replace(/\s+$/, ""));
  return parts.join("\n");
}

// Runs the built CLI out-of-process and returns combined stdout+stderr text.
// A non-zero exit code is a normal, renderable result for several of these
// commands (e.g. a failing conformance check), so we only treat it as fatal
// when execFile couldn't capture any output at all (spawn failure).
async function runCliCapture(entry) {
  const execArgs = [...entry.args];
  if (FORMAT_HUMAN_IDS.has(entry.id)) {
    execArgs.push("--format", "human");
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, ...execArgs],
      {
        timeout: entry.timeoutMs ?? 30000,
        env: { ...process.env, NO_COLOR: "1" },
        cwd: REPO_ROOT,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return combineOutput(stdout, stderr);
  } catch (err) {
    if (typeof err.stdout === "string" || typeof err.stderr === "string") {
      return combineOutput(err.stdout ?? "", err.stderr ?? "");
    }
    throw err;
  }
}

// `mcpjam mcp` runs forever serving JSON-RPC over stdio, so it needs a
// special capture path: spawn it, wait for the one-line stderr readiness
// banner, kill it, and render just that line.
async function runMcpStdioCapture(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...entry.args], {
      cwd: REPO_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
    });

    let settled = false;
    let stderrBuf = "";

    const timeoutMs = entry.timeoutMs ?? 3000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`timed out waiting for the stdio ready line after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(value);
    };

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.includes(MCP_STDIO_READY_LINE)) {
        finish(null, MCP_STDIO_READY_LINE);
      }
    });

    child.on("error", (err) => finish(err));
    child.on("exit", () => finish(new Error("process exited before the stdio ready line appeared")));
  });
}

async function captureTerminal(entry, { browser }) {
  const rawOutput =
    entry.id === "cli-mcp-stdio"
      ? await runMcpStdioCapture(entry)
      : await runCliCapture(entry);

  const cleaned = stripAnsi(rawOutput).replace(/\s+$/, "");
  const truncated = truncateLines(cleaned, MAX_OUTPUT_LINES);
  const escapedOutput = escapeHtml(truncated);
  const displayCommand = escapeHtml([entry.command, ...entry.args].join(" "));

  const template = readFileSync(TERMINAL_TEMPLATE_PATH, "utf8");
  const html = template
    .replaceAll("<!-- COMMAND -->", displayCommand)
    .replaceAll("<!-- OUTPUT -->", escapedOutput);

  const page = await browser.newPage({
    viewport: { width: 960, height: 700 },
    deviceScaleFactor: 2,
  });

  try {
    await page.setContent(html, { waitUntil: "load" });

    const finalPath = path.join(REPO_ROOT, entry.output);
    await mkdir(path.dirname(finalPath), { recursive: true });

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-screenshot-"));
    const tmpPath = path.join(tmpDir, "capture.png");

    await page.locator(".window").screenshot({ path: tmpPath });
    await rename(tmpPath, finalPath);
  } finally {
    await page.close();
  }
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

  // Only pay for a browser launch when a selected entry actually needs one;
  // --validate/--list return before this point, and there's no other kind yet.
  const needsBrowser = selected.some((entry) => entry.kind === "ui" || entry.kind === "terminal");
  // Pin the regular chromium build (not the separate chrome-headless-shell
  // package Playwright otherwise auto-selects for headless launches) so the
  // only setup step is `npx playwright install chromium`.
  const browser = needsBrowser ? await chromium.launch({ channel: "chromium" }) : null;

  let ok = 0;
  let failed = 0;

  try {
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
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  console.log(`${ok} ok, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
