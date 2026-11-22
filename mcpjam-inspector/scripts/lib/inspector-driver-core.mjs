/**
 * The pure half of the inspector driver (`scripts/inspector-driver.mjs`):
 * resolving a target, reading steps and the allowlist, classifying what a
 * page emitted, and formatting the report. No browser, no processes, so
 * `node --test` covers it without Playwright.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Kinds that fail a run. `console-warning` is reported but never fails. */
const FAILING_KINDS = new Set([
  "console-error",
  "page-error",
  "request-failed",
  "navigation-failed",
  "no-app-shell",
  "not-found",
  "still-loading",
  "step-failed",
  "wrong-route",
]);

export function isFailingKind(kind) {
  return FAILING_KINDS.has(kind) || /^http-[45]\d\d$/.test(kind);
}

// ── targets ───────────────────────────────────────────────────────────────

/**
 * A surface id, nav segment or sidebar title, a path, or an absolute URL, to
 * the URL to load. Project surfaces resolve to their logical path; the app
 * canonicalizes it to `/p/<projectId>/...` itself.
 */
export function resolveTarget(target, surfaces, baseUrl) {
  if (/^https?:\/\//i.test(target)) return { url: target, surfaceId: null };
  if (target.startsWith("/")) {
    return { url: new URL(target, baseUrl).href, surfaceId: null };
  }
  const wanted = target.toLowerCase();
  const surface =
    surfaces.find((s) => s.id === wanted) ??
    surfaces.find((s) => s.navSegments.includes(wanted)) ??
    surfaces.find((s) => s.title.toLowerCase() === wanted);
  if (!surface) {
    const near = surfaces
      .map((s) => s.id)
      .filter((id) => id.includes(wanted) || wanted.includes(id));
    throw new Error(
      `Unknown surface "${target}".` +
        (near.length ? ` Did you mean: ${near.join(", ")}?` : "") +
        " Run `surfaces` for the list, or pass a /path or URL.",
    );
  }
  return {
    url: new URL(surface.canonicalPath, baseUrl).href,
    surfaceId: surface.id,
  };
}

/** Accepts a bare token or a whole access link (`...#token=...`). */
export function parseAccessToken(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_-]{24,}$/.test(trimmed)) return trimmed;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  const token = new URLSearchParams(new URL(trimmed).hash.slice(1)).get(
    "token",
  );
  return token && /^[A-Za-z0-9_-]{24,}$/.test(token) ? token : null;
}

/**
 * The token `start` recorded, only when the driver is pointed at that same
 * instance: the browser seeds it into the target's localStorage, so another
 * origin must never receive it.
 */
export function recordedToken(baseUrl, state) {
  if (!state?.token) return null;
  return new URL(baseUrl).origin === new URL(state.baseUrl).origin
    ? state.token
    : null;
}

// ── steps ─────────────────────────────────────────────────────────────────

const STEP_ACTIONS = {
  goto: [],
  click: [],
  hover: [],
  fill: ["value"],
  press: [],
  waitFor: [],
  screenshot: [],
};

/**
 * Steps arrive as `[{ "click": "<selector>" }, ...]` or
 * `{ "start": "<surface>", "steps": [...] }`. Each step names exactly one
 * action; the normalized form is `{ action, target, value?, on?, state? }`.
 */
export function normalizeSteps(input) {
  const list = Array.isArray(input) ? input : input?.steps;
  const start = Array.isArray(input) ? undefined : input?.start;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      'Steps must be a non-empty array, or an object with a "steps" array.',
    );
  }
  const steps = list.map((step, index) => {
    const where = `step ${index + 1}`;
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(`${where}: expected an object like {"click": "..."}`);
    }
    const actions = Object.keys(step).filter((key) => key in STEP_ACTIONS);
    if (actions.length !== 1) {
      throw new Error(
        `${where}: name exactly one action (${Object.keys(STEP_ACTIONS).join(", ")}).`,
      );
    }
    const action = actions[0];
    const target = step[action];
    if (typeof target !== "string" || target === "") {
      throw new Error(`${where}: "${action}" needs a non-empty string.`);
    }
    for (const field of STEP_ACTIONS[action]) {
      if (typeof step[field] !== "string") {
        throw new Error(`${where}: "${action}" needs a string "${field}".`);
      }
    }
    if (
      step.state !== undefined &&
      !["visible", "hidden"].includes(step.state)
    ) {
      throw new Error(`${where}: "state" must be "visible" or "hidden".`);
    }
    return {
      action,
      target,
      ...(step.value !== undefined ? { value: step.value } : {}),
      ...(step.on !== undefined ? { on: String(step.on) } : {}),
      ...(step.state !== undefined ? { state: step.state } : {}),
    };
  });
  return { start, steps };
}

/** A run always begins on a page: a leading `goto`, or one made from `start`. */
export function withStartStep(steps, start) {
  if (steps[0].action === "goto") return steps;
  if (!start) {
    throw new Error(
      'The first step must be {"goto": ...}, or give a "start" surface (or --start).',
    );
  }
  return [{ action: "goto", target: start }, ...steps];
}

/**
 * Selector shorthands on top of Playwright's own engines (`role=`, `text=`,
 * `css=`, `data-testid=`): `testid=`, `label=` and `placeholder=` map to the
 * matching `getBy*` call, which is how the app's components are labelled.
 */
export function parseSelector(selector) {
  const match = /^(testid|label|placeholder)=(.+)$/s.exec(selector);
  if (match) return { by: match[1], value: match[2] };
  return { by: "selector", value: selector };
}

/** Fill values can be credentials, so the text names the field and hides the value. */
export function describeStep(step) {
  const parts = [step.action, step.target];
  if (step.value !== undefined) parts.push("(value hidden)");
  if (step.on !== undefined) parts.push(`on ${step.on}`);
  if (step.state !== undefined) parts.push(step.state);
  return parts.join(" ");
}

// ── allowlist ─────────────────────────────────────────────────────────────

const ACTORS = ["guest"];

/**
 * Validated allowlist rules. Each rule needs a reason, so the file explains
 * why every piece of tolerated noise is tolerated. `{origin}` in a match
 * stands for the app's own origin, so a rule cannot excuse the same path on
 * another host. `actor: "guest"` limits a rule to runs signed in as a guest,
 * and `replaced: true` to a failed request the page later made again and
 * got an answer for.
 */
export function parseAllowlist(json, source = "allowlist", { origin } = {}) {
  const rules = Array.isArray(json) ? json : json?.rules;
  if (!Array.isArray(rules)) {
    throw new Error(`${source}: expected { "rules": [...] }.`);
  }
  return rules.map((rule, index) => {
    const where = `${source} rule ${index + 1}`;
    if (typeof rule?.match !== "string" || rule.match === "") {
      throw new Error(`${where}: "match" must be a non-empty regex string.`);
    }
    if (typeof rule.reason !== "string" || rule.reason.trim() === "") {
      throw new Error(`${where}: "reason" is required.`);
    }
    if (rule.kind !== undefined && typeof rule.kind !== "string") {
      throw new Error(`${where}: "kind" must be a string.`);
    }
    if (rule.actor !== undefined && !ACTORS.includes(rule.actor)) {
      throw new Error(`${where}: "actor" must be one of ${ACTORS.join(", ")}.`);
    }
    if (rule.replaced !== undefined && rule.replaced !== true) {
      throw new Error(`${where}: "replaced" can only be true.`);
    }
    if (rule.match.includes("{origin}") && !origin) {
      throw new Error(`${where}: uses {origin}, but no app origin is known.`);
    }
    const escapedOrigin = origin?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      kind: rule.kind ?? "*",
      pattern: new RegExp(rule.match.replaceAll("{origin}", escapedOrigin)),
      reason: rule.reason,
      ...(rule.actor ? { actor: rule.actor } : {}),
      ...(rule.replaced ? { replaced: true } : {}),
    };
  });
}

/** `http-4xx` covers every 4xx status; `*` covers every kind. */
export function kindMatches(ruleKind, kind) {
  if (ruleKind === "*") return true;
  const family = /^http-(\d)xx$/.exec(ruleKind);
  if (family) return new RegExp(`^http-${family[1]}\\d\\d$`).test(kind);
  return ruleKind === kind;
}

/**
 * `context.guest` says the run signed in as a guest; `context.succeeded`
 * holds the "METHOD url" of every request the page got an answer for.
 */
export function findAllowRule(rules, issue, context = {}) {
  return rules.find(
    (rule) =>
      kindMatches(rule.kind, issue.kind) &&
      rule.pattern.test(issue.text) &&
      (!rule.actor || (rule.actor === "guest" && context.guest === true)) &&
      (!rule.replaced ||
        (issue.request !== undefined &&
          context.succeeded?.has(issue.request) === true)),
  );
}

// ── issues ────────────────────────────────────────────────────────────────

const SECRET_PARAM = /token|secret|key|code|session|password|signature/i;

/** Query values that may carry a credential never reach the report. */
export function redactUrl(raw) {
  if (raw.startsWith("data:")) return `${raw.slice(0, 40)}...`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_PARAM.test(key)) url.searchParams.set(key, "REDACTED");
  }
  if (url.hash.includes("token=")) url.hash = "REDACTED";
  return url.href;
}

const URL_IN_TEXT = /(?:https?|wss?):\/\/[^\s"'<>`]*[^\s"'<>`.,;:)]/gi;

/**
 * Free text (console lines, stacks, Playwright errors) with every URL in it
 * redacted and each of `secrets` replaced, so it can go into a report.
 */
export function redactText(text, secrets = []) {
  let out = String(text).replace(URL_IN_TEXT, (url) => redactUrl(url));
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** A `goto` target (surface, /path or URL) with its credentials removed. */
export function redactTarget(target) {
  if (!target.startsWith("/")) return redactText(target);
  const placeholder = "http://placeholder";
  return redactUrl(new URL(target, placeholder).href).slice(placeholder.length);
}

/** A step as it may be written to a report: no fill value, no URL credentials. */
export function redactStep(step) {
  return {
    ...step,
    ...(step.action === "goto" ? { target: redactTarget(step.target) } : {}),
    ...(step.value !== undefined ? { value: "[redacted]" } : {}),
  };
}

// ── routes ────────────────────────────────────────────────────────────────

/** A path without the `/p/<projectId>` prefix the app adds to project routes. */
function logicalPath(pathname) {
  return pathname.replace(/^\/p\/[^/]+/, "") || "/";
}

function matchesPattern(path, pattern) {
  const have = path.split("/").filter(Boolean);
  const want = pattern.split("/").filter(Boolean);
  return (
    have.length === want.length &&
    want.every((part, i) => part.startsWith(":") || part === have[i])
  );
}

/**
 * Why the page that loaded is not the one asked for, or null when it is. A
 * surface must land on one of its own route patterns; a path or URL must land
 * on the same origin and path. A clean shell elsewhere would otherwise pass
 * under the requested name.
 */
export function routeMismatch({ requestedUrl, finalUrl, surface }) {
  const requested = new URL(requestedUrl);
  const final = new URL(finalUrl);
  const landed = logicalPath(final.pathname);
  const ok =
    final.origin === requested.origin &&
    (surface
      ? surface.routePatterns.some((pattern) => matchesPattern(landed, pattern))
      : landed === logicalPath(requested.pathname));
  if (ok) return null;
  const wanted = surface
    ? `surface ${surface.id} (${surface.canonicalPath})`
    : redactUrl(requested.href);
  return `asked for ${wanted}, landed on ${redactUrl(final.href)}`;
}

/** One line, bounded, so a report stays greppable. */
export function oneLine(text, max = 220) {
  // Playwright colors its call logs; escape codes are noise in a text report.
  const flat = String(text)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * Split raw events into failing issues, warnings and allowed noise,
 * collapsing repeats into one entry with a count.
 */
export function classifyIssues(events, rules, context = {}) {
  const buckets = {
    issues: new Map(),
    warnings: new Map(),
    allowed: new Map(),
  };
  for (const event of events) {
    const text = oneLine(redactText(event.text));
    const rule = findAllowRule(
      rules,
      { kind: event.kind, text, request: event.request },
      context,
    );
    const bucket = rule
      ? buckets.allowed
      : isFailingKind(event.kind)
        ? buckets.issues
        : buckets.warnings;
    const key = `${event.kind}\u0000${text}`;
    const existing = bucket.get(key);
    if (existing) existing.count += 1;
    else
      bucket.set(key, {
        kind: event.kind,
        text,
        count: 1,
        ...(rule ? { reason: rule.reason } : {}),
      });
  }
  return {
    issues: [...buckets.issues.values()],
    warnings: [...buckets.warnings.values()],
    allowed: [...buckets.allowed.values()],
  };
}

function countOf(entries) {
  return entries.reduce((sum, entry) => sum + entry.count, 0);
}

function kindSummary(entries) {
  const byKind = new Map();
  for (const entry of entries) {
    byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + entry.count);
  }
  return [...byKind].map(([kind, n]) => `${kind} x${n}`).join(", ");
}

function entryLine(label, entry) {
  const times = entry.count > 1 ? ` (x${entry.count})` : "";
  return `  ${label.padEnd(7)} ${entry.kind.padEnd(15)} ${entry.text}${times}`;
}

/** Keeps a noisy page from burying the issues under warnings. */
const MAX_WARNING_LINES = 8;

/**
 * The compact text report for one `open` or `run`. Every finding line starts
 * with ISSUE or WARN and the last line with RESULT, so `grep` finds them.
 */
export function formatPageReport(report) {
  const { classified } = report;
  const lines = [
    `${report.label} -> ${report.finalUrl ? redactUrl(report.finalUrl) : "(no page)"}  (${report.seconds.toFixed(1)}s)`,
    `  title   ${report.title || "(none)"}`,
  ];
  for (const step of report.steps ?? []) {
    const status = step.ok ? "ok  " : "FAIL";
    const tail = step.ok ? "" : `  ${oneLine(step.error, 300)}`;
    lines.push(
      `  step ${String(step.index).padStart(2)} ${status} ${describeStep(step)}${tail}`,
    );
  }
  for (const entry of classified.issues) lines.push(entryLine("ISSUE", entry));
  for (const entry of classified.warnings.slice(0, MAX_WARNING_LINES)) {
    lines.push(entryLine("WARN", entry));
  }
  if (classified.warnings.length > MAX_WARNING_LINES) {
    lines.push(
      `  WARN    ... ${classified.warnings.length - MAX_WARNING_LINES} more in the report file`,
    );
  }
  if (classified.allowed.length > 0) {
    lines.push(
      `  allowed ${countOf(classified.allowed)} (${kindSummary(classified.allowed)})`,
    );
  }
  for (const [label, path] of Object.entries(report.artifacts)) {
    lines.push(`  ${label.padEnd(7)} ${path}`);
  }
  lines.push(resultLine(classified));
  return lines.join("\n");
}

export function resultLine(classified) {
  const failed = classified.issues.length > 0;
  return (
    `RESULT ${failed ? "fail" : "ok"} issues=${countOf(classified.issues)}` +
    ` warnings=${countOf(classified.warnings)} allowed=${countOf(classified.allowed)}`
  );
}

/** One sweep row: status, surface, where it landed, counts, first issue. */
export function formatSweepLine(row, idWidth = 20) {
  const { classified } = row;
  const failed = classified.issues.length > 0;
  const first = classified.issues[0];
  return [
    failed ? "FAIL" : "ok  ",
    row.surfaceId.padEnd(idWidth),
    (row.finalPath ?? "(no page)").padEnd(32),
    `issues=${countOf(classified.issues)}`,
    `warnings=${countOf(classified.warnings)}`,
    `${row.seconds.toFixed(1)}s`,
    ...(first ? [`first=${first.kind}: ${oneLine(first.text, 120)}`] : []),
  ].join("  ");
}

/** The final URL's path with the project id shortened, for sweep rows. */
export function displayPath(finalUrl) {
  if (!finalUrl) return null;
  const { pathname } = new URL(finalUrl);
  return pathname.replace(/^\/p\/[^/]+/, "/p/<id>");
}

export function artifactSlug(label) {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "page"
  );
}

// ── processes ─────────────────────────────────────────────────────────────

/**
 * npm's JS entry point, run with this Node so no shell is needed: Node
 * refuses to spawn the Windows `npm.cmd` shim without one (CVE-2024-27980).
 * Null means "use `npm` from PATH", which is fine outside Windows.
 */
export function resolveNpmCli({
  env = process.env,
  execPath = process.execPath,
  exists = existsSync,
} = {}) {
  if (env.npm_execpath && /npm-cli\.[cm]?js$/.test(env.npm_execpath)) {
    return env.npm_execpath;
  }
  const bundled = join(
    dirname(execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (exists(bundled)) return bundled;
  const unixPrefix = join(
    dirname(execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  return exists(unixPrefix) ? unixPrefix : null;
}

/** The launcher log without the line that signs a browser in. */
export function redactLog(text) {
  return text
    .split(/\r?\n/)
    .map((line) => (/[#&]token=/.test(line) ? "[access link redacted]" : line))
    .join("\n");
}
