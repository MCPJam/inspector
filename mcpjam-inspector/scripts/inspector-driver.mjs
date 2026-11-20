#!/usr/bin/env node

/**
 * Drive a running inspector the way a reviewer would, and print what
 * happened as short, greppable text with the screenshots and ARIA snapshots
 * on disk. Lets an agent prove a UI change works instead of arguing it from
 * the diff. See .agents/skills/run-inspector/SKILL.md.
 *
 *   node scripts/inspector-driver.mjs surfaces
 *   node scripts/inspector-driver.mjs start [--instance N] [--worker] [--skip-prepare]
 *                                           [--env-file <profile>]
 *   node scripts/inspector-driver.mjs status | stop
 *   node scripts/inspector-driver.mjs open <surface|/path|url> [--theme light|dark]
 *   node scripts/inspector-driver.mjs run <steps.json|inline-json> [--start <surface>]
 *   node scripts/inspector-driver.mjs sweep [--only a,b] [--skip a,b]
 *
 * Browser commands use --base-url / MCPJAM_DRIVER_BASE_URL and --token /
 * MCPJAM_SESSION_TOKEN (a token or the whole access link), falling back to
 * the instance `start` recorded. Exit codes: 0 clean, 1 an issue was found,
 * 2 the driver itself could not run.
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
  resolveTarget,
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
  instance: { type: "string" },
  timeout: { type: "string" },
  "step-timeout": { type: "string" },
  "ready-timeout": { type: "string" },
  fresh: { type: "boolean" },
  headed: { type: "boolean" },
  worker: { type: "boolean" },
  "skip-prepare": { type: "boolean" },
  "env-file": { type: "string" },
  help: { type: "boolean", short: "h" },
};

async function loadSurfaces() {
  const { listAppSurfaces } = await import("../shared/app-surfaces.ts");
  return listAppSurfaces();
}

function positiveInt(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`--${name} must be a positive integer`);
  return n;
}

async function connection(values) {
  const { readState } = await import("./lib/inspector-driver-instance.mjs");
  const state = readState(INSPECTOR_DIR);
  const baseUrl =
    values["base-url"] ?? process.env.MCPJAM_DRIVER_BASE_URL ?? state?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      "No instance to drive: run `start`, or pass --base-url (or MCPJAM_DRIVER_BASE_URL).",
    );
  }
  const rawToken = values.token ?? process.env.MCPJAM_SESSION_TOKEN;
  const token = rawToken ? parseAccessToken(rawToken) : (state?.token ?? null);
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

function loadAllowlist(values) {
  const path = values.allowlist ? resolve(values.allowlist) : DEFAULT_ALLOWLIST;
  if (!existsSync(path)) {
    if (values.allowlist) throw new Error(`No allowlist at ${path}`);
    return [];
  }
  return parseAllowlist(JSON.parse(readFileSync(path, "utf8")), path);
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
  const { baseUrl, token } = await connection(values);
  const surfaces = await loadSurfaces();
  const rules = loadAllowlist(values);
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
  const page = await session.context.newPage();
  const events = browserLib.recordEvents(page);
  const started = Date.now();
  const slug = artifactSlug(
    `${label ?? surfaceId ?? target}${values.theme ? `-${values.theme}` : ""}`,
  );
  try {
    await browserLib.loadAndSettle(page, url, events, timeoutMs);
  } catch (error) {
    events.push({ kind: "navigation-failed", text: error.message });
  }
  const seconds = (Date.now() - started) / 1_000;
  const artifacts = await browserLib.captureArtifacts(page, outDir, slug);
  const report = {
    label: `OPEN ${surfaceId ?? target}`,
    surfaceId: surfaceId ?? target,
    requestedUrl: url,
    finalUrl: page.url(),
    title: await page.title(),
    seconds,
    classified: classifyIssues(events, rules),
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
      finalUrl: page.url(),
      title: await page.title(),
      seconds: (Date.now() - started) / 1_000,
      steps: results,
      classified: classifyIssues(events, rules),
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

async function cmdStart(values) {
  const { startInstance } = await import("./lib/inspector-driver-instance.mjs");
  const instance =
    values.instance === undefined ? undefined : Number(values.instance);
  if (instance !== undefined && (!Number.isInteger(instance) || instance < 0)) {
    throw new Error("--instance must be a non-negative integer");
  }
  const state = await startInstance({
    inspectorDir: INSPECTOR_DIR,
    instance,
    worker: values.worker,
    prepare: !values["skip-prepare"],
    envFile: values["env-file"],
    timeoutSeconds: positiveInt(values["ready-timeout"], "ready-timeout", 300),
  });
  process.stdout.write(`base-url ${state.baseUrl}\n`);
  return 0;
}

async function cmdStatus() {
  const { readState, isOurProcess } =
    await import("./lib/inspector-driver-instance.mjs");
  const state = readState(INSPECTOR_DIR);
  if (!state) {
    process.stdout.write("no driver instance recorded for this checkout\n");
    return 0;
  }
  const alive = isOurProcess(state);
  process.stdout.write(
    `instance ${state.instance} ${alive ? "running" : "NOT running"} pid ${state.pid} ${state.baseUrl} log ${state.logPath}\n`,
  );
  return alive ? 0 : 1;
}

async function cmdStop() {
  const { stopInstance } = await import("./lib/inspector-driver-instance.mjs");
  await stopInstance({ inspectorDir: INSPECTOR_DIR });
  return 0;
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
    case "start":
      return cmdStart(values);
    case "status":
      return cmdStatus();
    case "stop":
      return cmdStop();
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
