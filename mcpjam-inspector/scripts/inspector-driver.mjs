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
 *   node scripts/inspector-driver.mjs record <steps.json|inline-json> [--start <surface>]
 *                                            [--theme light|dark] [--out <dir>]
 *   node scripts/inspector-driver.mjs compare <dir with before/ and after/>
 *
 * `record` runs the steps once per theme with video and writes evidence.md
 * for the PR body; `compare` pairs two records into one before/after
 * evidence.md. See .agents/skills/pr-evidence/SKILL.md.
 *
 * Browser commands use --base-url / MCPJAM_DRIVER_BASE_URL and --token /
 * MCPJAM_SESSION_TOKEN (a token or the whole access link), falling back to
 * the instance `start` recorded (its token only ever goes to its own origin).
 * --checkout <dir> points start, status, stop and the browser commands at
 * another checkout's instance, for example a worktree of the base ref. Exit
 * codes: 0 clean, 1 an issue was found, 2 the driver itself could not run.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  EVIDENCE_THEMES,
  artifactSlug,
  classifyIssues,
  describeStep,
  displayPath,
  formatComparison,
  formatEvidence,
  formatPageReport,
  formatSweepLine,
  normalizeSteps,
  parseAccessToken,
  parseAllowlist,
  recordedToken,
  redactStep,
  redactText,
  redactUrl,
  resolveTarget,
  resultLine,
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
  instance: { type: "string" },
  timeout: { type: "string" },
  "step-timeout": { type: "string" },
  "ready-timeout": { type: "string" },
  fresh: { type: "boolean" },
  headed: { type: "boolean" },
  worker: { type: "boolean" },
  "skip-prepare": { type: "boolean" },
  "env-file": { type: "string" },
  checkout: { type: "string" },
  help: { type: "boolean", short: "h" },
};

/** The inspector package of this checkout, or of the one --checkout names. */
function inspectorDir(values) {
  if (!values.checkout) return INSPECTOR_DIR;
  const root = resolve(values.checkout);
  const nested = join(root, "mcpjam-inspector");
  const dir = existsSync(join(nested, "package.json")) ? nested : root;
  if (!existsSync(join(dir, "package.json"))) {
    throw new Error(`--checkout ${root} is not an inspector checkout.`);
  }
  return dir;
}

/**
 * The commit and dirty flag of a checkout. The dev server serves the working
 * tree, so for an instance `start` launched there this is the code it runs,
 * except build output made at start (the SDK and bundles). Uncommitted
 * changes are flagged because a screenshot of them matches no commit a
 * reviewer can check out.
 */
function commitOf(dir) {
  const git = (...args) =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  const head = git("rev-parse", "HEAD");
  if (head.status !== 0) {
    throw new Error(`git rev-parse HEAD failed in ${dir}: ${head.stderr}`);
  }
  const status = git("status", "--porcelain");
  if (status.status !== 0) {
    throw new Error(`git status failed in ${dir}: ${status.stderr}`);
  }
  return { sha: head.stdout.trim(), dirty: status.stdout.trim() !== "" };
}

/** The surfaces of the checkout being driven, so its own routes are used. */
async function loadSurfaces(dir = INSPECTOR_DIR) {
  try {
    const { listAppSurfaces } = await import(
      pathToFileURL(join(dir, "shared", "app-surfaces.ts")).href
    );
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

async function connection(values) {
  const { readState } = await import("./lib/inspector-driver-instance.mjs");
  const state = readState(inspectorDir(values));
  const givenUrl = values["base-url"] ?? process.env.MCPJAM_DRIVER_BASE_URL;
  const baseUrl = givenUrl ?? state?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      "No instance to drive: run `start`, or pass --base-url (or MCPJAM_DRIVER_BASE_URL).",
    );
  }
  const rawToken = values.token ?? process.env.MCPJAM_SESSION_TOKEN;
  const token = rawToken
    ? parseAccessToken(rawToken)
    : recordedToken(baseUrl, state);
  if (rawToken && !token) {
    throw new Error("--token is neither an access token nor an access link.");
  }
  // Only an instance `start` recorded has a known checkout behind it.
  return { baseUrl, token, state: givenUrl ? null : state };
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

async function withPage(values, fn, { video = false } = {}) {
  checkTheme(values.theme);
  const { baseUrl, token } = await connection(values);
  const surfaces = await loadSurfaces(inspectorDir(values));
  const rules = loadAllowlist(values);
  const outDir = outputDir(values);
  const browserLib = await import("./lib/inspector-driver-browser.mjs");
  const session = await browserLib.openContext({
    baseUrl,
    token,
    theme: values.theme,
    fresh: values.fresh,
    headed: values.headed,
    videoDir: video ? outDir : undefined,
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

/**
 * Run the steps on a fresh page and capture where they ended. The page stays
 * open so `record` can close it and keep its video. `prefix` keeps step
 * screenshots from two themes in one folder apart.
 */
async function drive({ ctx, values, steps, slug, prefix = "" }) {
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
    const key = artifactSlug(`${prefix}${name}`);
    const path = join(outDir, `${key}.png`);
    await page.screenshot({ path });
    shots[key] = path;
  };
  const results = await browserLib.runSteps({
    page,
    steps,
    events,
    resolveUrl,
    stepTimeoutMs,
    loadTimeoutMs,
    shoot,
  });
  const artifacts = {
    ...shots,
    ...(await browserLib.captureArtifacts(page, outDir, slug)),
  };
  const report = {
    label: `RUN ${steps.length} steps`,
    finalUrl: redactUrl(page.url()),
    title: await page.title(),
    seconds: (Date.now() - started) / 1_000,
    steps: results,
    classified: classifyIssues(events, rules),
    artifacts,
  };
  report.artifacts.report = writeReport(outDir, slug, report);
  return { report, page, stepShots: Object.values(shots) };
}

function readRunSteps(values, arg, command) {
  if (!arg) throw new Error(`${command} needs a steps file or inline JSON`);
  const { start, steps } = readSteps(arg);
  return withStartStep(steps, values.start ?? start);
}

async function cmdRun(values, arg) {
  const steps = readRunSteps(values, arg, "run");
  return withPage(values, async (ctx) => {
    const slug = artifactSlug(
      `run-final${values.theme ? `-${values.theme}` : ""}`,
    );
    const { report } = await drive({ ctx, values, steps, slug });
    process.stdout.write(`${formatPageReport(report)}\n`);
    return report.classified.issues.length > 0 ? 1 : 0;
  });
}

/** One themed run with video, as the entry `evidence.json` keeps for it. */
async function recordTheme(values, steps, theme) {
  return withPage(
    { ...values, theme },
    async (ctx) => {
      const { report, page, stepShots } = await drive({
        ctx,
        values,
        steps,
        slug: `${theme}-final`,
        prefix: `${theme}-`,
      });
      const video = page.video();
      // Playwright finishes writing a video only once its page is closed.
      await page.close();
      report.artifacts.video = join(ctx.outDir, `${theme}.webm`);
      await video.saveAs(report.artifacts.video);
      await video.delete();
      writeReport(ctx.outDir, `${theme}-final`, report);
      process.stdout.write(`${formatPageReport(report)}\n`);
      const { classified, artifacts } = report;
      return {
        theme,
        ok: classified.issues.length === 0,
        result: resultLine(classified),
        issues: classified.issues,
        warnings: classified.warnings,
        artifacts: {
          screenshot: basename(artifacts.shot),
          video: basename(artifacts.video),
          aria: basename(artifacts.aria),
          report: basename(artifacts.report),
          steps: stepShots.map((path) => basename(path)),
        },
      };
    },
    { video: true },
  );
}

/**
 * The commit of the checkout behind the instance `start` recorded, once that
 * instance is shown to be the one still answering: its launcher is alive and
 * the server accepts the token only that launch knows.
 */
async function servedCommit(dir, state) {
  const { answersToToken, isOurProcess } =
    await import("./lib/inspector-driver-instance.mjs");
  if (!isOurProcess(state) || !(await answersToToken(state.baseUrl, state.token))) {
    throw new Error(
      `The instance recorded for ${dir} is not the one answering at ${state.baseUrl}. Run \`stop\` and \`start\` again.`,
    );
  }
  return commitOf(dir);
}

async function cmdRecord(values, arg) {
  const steps = readRunSteps(values, arg, "record");
  checkTheme(values.theme);
  const { state } = await connection(values);
  const dir = inspectorDir(values);
  const commit = state ? await servedCommit(dir, state) : null;
  const outDir = outputDir(values);
  // A manifest left by an earlier attempt would point at this attempt's
  // half-written files if it failed, so it goes before anything is captured.
  for (const name of ["evidence.json", "evidence.md"]) {
    rmSync(join(outDir, name), { force: true });
  }
  const capturedAt = new Date().toISOString();
  const runs = [];
  for (const theme of values.theme ? [values.theme] : EVIDENCE_THEMES) {
    runs.push(await recordTheme({ ...values, out: outDir }, steps, theme));
  }
  if (commit && JSON.stringify(commitOf(dir)) !== JSON.stringify(commit)) {
    throw new Error(
      `${dir} changed while recording (it was ${commit.sha}${commit.dirty ? " plus changes" : ""}); no evidence written. Record again.`,
    );
  }
  const { VIEWPORT } = await import("./lib/inspector-driver-browser.mjs");
  const evidence = {
    capturedAt,
    commit,
    viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
    settings: {
      browser: values.headed ? "headed" : "headless",
      fresh: Boolean(values.fresh),
    },
    steps: steps.map(describeStep),
    // What compare checks: the steps as run, with fill values redacted.
    canonicalSteps: steps.map(redactStep),
    runs,
  };
  writeFileSync(
    join(outDir, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  const markdown = join(outDir, "evidence.md");
  writeFileSync(markdown, formatEvidence(evidence));
  process.stdout.write(`EVIDENCE ${markdown}\n`);
  return runs.every((run) => run.ok) ? 0 : 1;
}

function readEvidence(dir, side) {
  const path = join(dir, side, "evidence.json");
  if (!existsSync(path)) {
    throw new Error(
      `No ${path}. Run \`record <steps> --out ${join(dir, side)}\` first.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

async function cmdCompare(arg) {
  if (!arg)
    throw new Error("compare needs the folder holding before/ and after/");
  const dir = resolve(arg);
  const markdown = join(dir, "evidence.md");
  writeFileSync(
    markdown,
    formatComparison(readEvidence(dir, "before"), readEvidence(dir, "after")),
  );
  process.stdout.write(`EVIDENCE ${markdown}\n`);
  return 0;
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

async function cmdStart(values) {
  const { startInstance } = await import("./lib/inspector-driver-instance.mjs");
  const instance =
    values.instance === undefined ? undefined : Number(values.instance);
  if (instance !== undefined && (!Number.isInteger(instance) || instance < 0)) {
    throw new Error("--instance must be a non-negative integer");
  }
  const state = await startInstance({
    inspectorDir: inspectorDir(values),
    instance,
    worker: values.worker,
    prepare: !values["skip-prepare"],
    envFile: values["env-file"],
    timeoutSeconds: positiveInt(values["ready-timeout"], "ready-timeout", 300),
  });
  process.stdout.write(`base-url ${state.baseUrl}\n`);
  return 0;
}

async function cmdStatus(values) {
  const { readState, isOurProcess } =
    await import("./lib/inspector-driver-instance.mjs");
  const state = readState(inspectorDir(values));
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

async function cmdStop(values) {
  const { stopInstance } = await import("./lib/inspector-driver-instance.mjs");
  await stopInstance({ inspectorDir: inspectorDir(values) });
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
      return cmdStatus(values);
    case "stop":
      return cmdStop(values);
    case "open":
      return cmdOpen(values, arg);
    case "run":
      return cmdRun(values, arg);
    case "sweep":
      return cmdSweep(values);
    case "record":
      return cmdRecord(values, arg);
    case "compare":
      return cmdCompare(arg);
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
