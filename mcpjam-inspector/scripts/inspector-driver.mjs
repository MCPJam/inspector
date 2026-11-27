#!/usr/bin/env node

/**
 * Drive a running inspector the way a reviewer would, and print what
 * happened as short, greppable text with the screenshots and ARIA snapshots
 * on disk. Lets an agent prove a UI change works instead of arguing it from
 * the diff. See .agents/skills/run-inspector/SKILL.md.
 *
 *   node scripts/inspector-driver.mjs surfaces
 *   node scripts/inspector-driver.mjs open <surface|/path|url> [--theme light|dark]
 *   node scripts/inspector-driver.mjs run <steps.json|inline-json> [--start <surface>]
 *   node scripts/inspector-driver.mjs sweep [--only a,b] [--skip a,b]
 *
 * Browser commands drive an instance you started: --base-url /
 * MCPJAM_DRIVER_BASE_URL and --token / MCPJAM_SESSION_TOKEN (a token or the
 * whole access link). Exit codes: 0 clean, 1 an issue was found, 2 the driver itself could not run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  artifactSlug,
  classifyIssues,
  displayPath,
  formatPageReport,
  formatSweepLine,
  normalizeSteps,
  parseAccessToken,
  parseAllowlist,
  redactText,
  redactUrl,
  resolveTarget,
  routeMismatch,
  withStartStep,
} from "./lib/inspector-driver-core.mjs";

const INSPECTOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ALLOWLIST = join(
  INSPECTOR_DIR,
  "scripts",
  "inspector-driver.allowlist.json",
);

const OPTIONS = {
  "base-url": { type: "string" },
  token: { type: "string" },
  out: { type: "string" },
  allowlist: { type: "string" },
  theme: { type: "string" },
  start: { type: "string" },
  only: { type: "string" },
  skip: { type: "string" },
  timeout: { type: "string" },
  "step-timeout": { type: "string" },
  fresh: { type: "boolean" },
  headed: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

async function loadSurfaces() {
  try {
    const { listAppSurfaces } = await import("../shared/app-surfaces.ts");
    return listAppSurfaces();
  } catch (error) {
    // The package allows Node 22.0, but Node only strips TypeScript types
    // without a flag from 22.18.0.
    if (error.code !== "ERR_UNKNOWN_FILE_EXTENSION") throw error;
    throw new Error(
      `Reading shared/app-surfaces.ts needs Node 22.18.0 or later (this is ${process.version}), or 22.6.0 or later with NODE_OPTIONS=--experimental-strip-types.`,
    );
  }
}

function positiveInt(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`--${name} must be a positive integer`);
  return n;
}

function connection(values) {
  const baseUrl = values["base-url"] ?? process.env.MCPJAM_DRIVER_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "No instance to drive: start one (run-inspector skill) and pass --base-url (or MCPJAM_DRIVER_BASE_URL).",
    );
  }
  const rawToken = values.token ?? process.env.MCPJAM_SESSION_TOKEN;
  const token = rawToken ? parseAccessToken(rawToken) : null;
  if (rawToken && !token) {
    throw new Error("--token is neither an access token nor an access link.");
  }
  return { baseUrl, token };
}

function outputDir(values) {
  const dir = values.out
    ? resolve(values.out)
    : join(
        homedir(),
        ".mcpjam",
        "driver",
        "runs",
        new Date().toISOString().replace(/[:.]/g, "-"),
      );
  // Screenshots can show account data, so the default location is private.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function loadAllowlist(values, origin) {
  const path = values.allowlist ? resolve(values.allowlist) : DEFAULT_ALLOWLIST;
  if (!existsSync(path)) {
    if (values.allowlist) throw new Error(`No allowlist at ${path}`);
    return [];
  }
  return parseAllowlist(JSON.parse(readFileSync(path, "utf8")), path, {
    origin,
  });
}

function checkTheme(theme) {
  if (theme !== undefined && !["light", "dark"].includes(theme)) {
    throw new Error("--theme must be light or dark");
  }
}

function writeReport(outDir, slug, report) {
  const path = join(outDir, `${slug}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

async function withPage(values, fn) {
  checkTheme(values.theme);
  const { baseUrl, token } = connection(values);
  const surfaces = await loadSurfaces();
  const rules = loadAllowlist(values, new URL(baseUrl).origin);
  const outDir = outputDir(values);
  const browserLib = await import("./lib/inspector-driver-browser.mjs");
  const session = await browserLib.openContext({
    baseUrl,
    token,
    theme: values.theme,
    fresh: values.fresh,
    headed: values.headed,
  });
  try {
    return await fn({
      baseUrl,
      token,
      surfaces,
      rules,
      outDir,
      session,
      browserLib,
    });
  } finally {
    await session.close();
  }
}

/** Open one target in a fresh page and return its finished report. */
async function visit({ target, label, ctx, values }) {
  const { surfaces, baseUrl, rules, outDir, session, browserLib } = ctx;
  const timeoutMs = positiveInt(values.timeout, "timeout", 30) * 1_000;
  const { url, surfaceId } = resolveTarget(target, surfaces, baseUrl);
  const surface = surfaces.find((s) => s.id === surfaceId);
  const shown = surfaceId ?? redactUrl(url);
  const page = await session.context.newPage();
  const events = browserLib.recordEvents(page);
  const succeeded = browserLib.recordSucceeded(page);
  const started = Date.now();
  const slug = artifactSlug(
    `${label ?? shown}${values.theme ? `-${values.theme}` : ""}`,
  );
  try {
    await browserLib.loadAndSettle(page, url, events, timeoutMs);
    const mismatch = routeMismatch({
      requestedUrl: url,
      finalUrl: page.url(),
      surface,
    });
    if (mismatch) events.push({ kind: "wrong-route", text: mismatch });
  } catch (error) {
    events.push({
      kind: "navigation-failed",
      text: redactText(error.message),
    });
  }
  const seconds = (Date.now() - started) / 1_000;
  const artifacts = await browserLib.captureArtifacts(page, outDir, slug);
  const report = {
    label: `OPEN ${shown}`,
    surfaceId: shown,
    requestedUrl: redactUrl(url),
    finalUrl: redactUrl(page.url()),
    title: await page.title(),
    seconds,
    classified: classifyIssues(events, rules, {
      guest: session.guestMinted(),
      succeeded,
    }),
    artifacts,
  };
  report.artifacts.report = writeReport(outDir, slug, report);
  await page.close();
  return report;
}

async function cmdSurfaces() {
  const surfaces = await loadSurfaces();
  const width = Math.max(...surfaces.map((s) => s.id.length));
  for (const s of surfaces) {
    const flags = [
      s.hostedBlocked ? "hosted-blocked" : "",
      s.showInAtlas ? "" : "not-in-atlas",
    ]
      .filter(Boolean)
      .join(",");
    process.stdout.write(
      `${s.id.padEnd(width)}  ${s.scope.padEnd(7)}  ${s.canonicalPath.padEnd(20)}  ${s.title}${flags ? `  [${flags}]` : ""}\n`,
    );
  }
  return 0;
}

async function cmdOpen(values, target) {
  if (!target) throw new Error("open needs a surface id, /path or URL");
  return withPage(values, async (ctx) => {
    const report = await visit({ target, ctx, values });
    process.stdout.write(`${formatPageReport(report)}\n`);
    return report.classified.issues.length > 0 ? 1 : 0;
  });
}

function readSteps(arg) {
  const text = /^\s*[[{]/.test(arg) ? arg : readFileSync(resolve(arg), "utf8");
  return normalizeSteps(JSON.parse(text));
}

async function cmdRun(values, arg) {
  if (!arg) throw new Error("run needs a steps file or inline JSON");
  const { start, steps } = readSteps(arg);
  const all = withStartStep(steps, values.start ?? start);
  return withPage(values, async (ctx) => {
    const { surfaces, baseUrl, rules, outDir, session, browserLib } = ctx;
    const stepTimeoutMs =
      positiveInt(values["step-timeout"], "step-timeout", 10) * 1_000;
    const loadTimeoutMs = positiveInt(values.timeout, "timeout", 30) * 1_000;
    const resolveUrl = (target) => resolveTarget(target, surfaces, baseUrl).url;
    const page = await session.context.newPage();
    const events = browserLib.recordEvents(page);
    const succeeded = browserLib.recordSucceeded(page);
    const started = Date.now();
    const shots = {};
    const shoot = async (name) => {
      const path = join(outDir, `${artifactSlug(name)}.png`);
      await page.screenshot({ path });
      shots[artifactSlug(name)] = path;
    };
    const results = await browserLib.runSteps({
      page,
      steps: all,
      events,
      resolveUrl,
      stepTimeoutMs,
      loadTimeoutMs,
      shoot,
    });
    const slug = artifactSlug(
      `run-final${values.theme ? `-${values.theme}` : ""}`,
    );
    const artifacts = {
      ...shots,
      ...(await browserLib.captureArtifacts(page, outDir, slug)),
    };
    const report = {
      label: `RUN ${all.length} steps`,
      finalUrl: redactUrl(page.url()),
      title: await page.title(),
      seconds: (Date.now() - started) / 1_000,
      steps: results,
      classified: classifyIssues(events, rules, {
        guest: session.guestMinted(),
        succeeded,
      }),
      artifacts,
    };
    report.artifacts.report = writeReport(outDir, slug, report);
    process.stdout.write(`${formatPageReport(report)}\n`);
    return report.classified.issues.length > 0 ? 1 : 0;
  });
}

function idList(value) {
  return value
    ? value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
}

async function cmdSweep(values) {
  return withPage(values, async (ctx) => {
    const only = idList(values.only);
    const skip = idList(values.skip) ?? [];
    const known = new Set(ctx.surfaces.map((s) => s.id));
    for (const id of [...(only ?? []), ...skip]) {
      if (!known.has(id))
        throw new Error(`Unknown surface "${id}" in --only/--skip`);
    }
    const chosen = ctx.surfaces.filter(
      (s) => (!only || only.includes(s.id)) && !skip.includes(s.id),
    );
    if (chosen.length === 0) {
      throw new Error("--only/--skip left no surfaces to sweep.");
    }
    const width = Math.max(...chosen.map((s) => s.id.length));
    process.stdout.write(
      `SWEEP ${chosen.length} surfaces against ${ctx.baseUrl}\n`,
    );
    const rows = [];
    for (const surface of chosen) {
      const report = await visit({ target: surface.id, ctx, values });
      const row = {
        surfaceId: surface.id,
        finalPath: displayPath(report.finalUrl),
        seconds: report.seconds,
        classified: report.classified,
      };
      rows.push(row);
      process.stdout.write(`${formatSweepLine(row, width)}\n`);
    }
    const failed = rows.filter((r) => r.classified.issues.length > 0).length;
    process.stdout.write(
      `SWEEP ok=${rows.length - failed} fail=${failed} out=${ctx.outDir}\n`,
    );
    return failed > 0 ? 1 : 0;
  });
}

const HELP = readFileSync(fileURLToPath(import.meta.url), "utf8")
  .split("*/")[0]
  .split("\n")
  .slice(3)
  .map((line) => line.replace(/^ \*? ?/, ""))
  .join("\n");

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  });
  const [command, arg] = positionals;
  if (values.help || !command) {
    process.stdout.write(`${HELP}\n`);
    return command ? 0 : 2;
  }
  switch (command) {
    case "surfaces":
      return cmdSurfaces();
    case "open":
      return cmdOpen(values, arg);
    case "run":
      return cmdRun(values, arg);
    case "sweep":
      return cmdSweep(values);
    default:
      throw new Error(`Unknown command "${command}"`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`inspector-driver: ${error.message}\n`);
    process.exit(2);
  },
);
