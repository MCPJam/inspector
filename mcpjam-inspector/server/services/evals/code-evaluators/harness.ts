/**
 * How a code evaluator's source becomes something a sandbox can run, and how
 * its output becomes a result.
 *
 * Types are stripped here with Node's own `stripTypeScriptTypes`, so the
 * sandbox runs plain JavaScript and needs no compiler. Only erasable syntax
 * is supported (no `enum` or `namespace`); anything else is a clear error
 * row, not a crash.
 */
import { stripTypeScriptTypes } from "node:module";
import type { CodeEvaluatorRunResult } from "./types.js";

/** Per trial. */
export const CODE_EVALUATOR_TIMEOUT_MS = 10_000;
/** What the code printed, kept with the result. */
export const CODE_EVALUATOR_LOG_CHARS = 16_000;
/** Bump when the harness or the result rules change; part of scorer identity. */
export const CODE_EVALUATOR_RUNNER_VERSION = "1";

const RESULT_MARKER = "@@MCPJAM_CODE_RESULT@@";

export type PreparedSource =
  | { ok: true; module: string }
  | { ok: false; reason: string };

/** The author's TypeScript as a CommonJS-free ES module, or why not. */
export function prepareSource(source: string): PreparedSource {
  try {
    return {
      ok: true,
      module: stripTypeScriptTypes(source, { mode: "strip" }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `The source isn't TypeScript this runner can strip (erasable types only; no enum or namespace): ${message.slice(0, 300)}`,
    };
  }
}

/**
 * The script the sandbox runs: import the evaluator, call `evaluate` with
 * the run, and print one marked JSON line. Anything else it prints is logs.
 */
export const HARNESS_SCRIPT = `
import { readFile } from "node:fs/promises";
const run = JSON.parse(await readFile(new URL("./run.json", import.meta.url), "utf8"));
const marker = ${JSON.stringify(RESULT_MARKER)};
try {
  const mod = await import("./evaluator.mjs");
  if (typeof mod.evaluate !== "function") throw new Error("the source does not export a function named evaluate");
  const value = await mod.evaluate(run);
  process.stdout.write("\\n" + marker + JSON.stringify({ value }) + "\\n");
} catch (error) {
  const message = error && error.stack ? String(error.stack) : String(error);
  process.stdout.write("\\n" + marker + JSON.stringify({ error: message.slice(0, 2000) }) + "\\n");
}
`;

function clipLogs(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > CODE_EVALUATOR_LOG_CHARS
    ? `${trimmed.slice(0, CODE_EVALUATOR_LOG_CHARS)}\n[logs clipped]`
    : trimmed;
}

/**
 * Read the harness output. Only `{ pass: boolean, score?: 0..1, reason:
 * string }` scores; every other shape is an error the author can act on.
 */
export function parseHarnessOutput(stdout: string): CodeEvaluatorRunResult {
  const at = stdout.lastIndexOf(RESULT_MARKER);
  const logs = clipLogs(at >= 0 ? stdout.slice(0, at) : stdout);
  const withLogs = logs ? { logs } : {};
  if (at < 0) {
    return {
      status: "error",
      reason: "evaluate() produced no result before the process ended.",
      ...withLogs,
    };
  }
  let parsed: { value?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(stdout.slice(at + RESULT_MARKER.length).trim());
  } catch {
    return { status: "error", reason: "evaluate() returned a value that isn't JSON.", ...withLogs };
  }
  if (typeof parsed.error === "string") {
    return { status: "error", reason: `evaluate() threw: ${parsed.error}`, ...withLogs };
  }
  const value = parsed.value as Record<string, unknown> | null | undefined;
  const shapeError = (detail: string): CodeEvaluatorRunResult => ({
    status: "error",
    reason: `evaluate() returned ${JSON.stringify(value)?.slice(0, 200)}; expected { pass, reason }${detail}.`,
    ...withLogs,
  });
  if (!value || typeof value !== "object") return shapeError("");
  if (typeof value.pass !== "boolean") return shapeError(" with pass true or false");
  if (typeof value.reason !== "string" || !value.reason.trim()) {
    return shapeError(" with a reason");
  }
  if (
    value.score !== undefined &&
    (typeof value.score !== "number" || value.score < 0 || value.score > 1)
  ) {
    return shapeError(" with score between 0 and 1");
  }
  return {
    status: "scored",
    pass: value.pass,
    ...(typeof value.score === "number" ? { score: value.score } : {}),
    reason: value.reason.trim().slice(0, 1000),
    ...withLogs,
  };
}
