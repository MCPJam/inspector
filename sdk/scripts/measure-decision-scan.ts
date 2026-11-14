/**
 * Measures MCPJam's decision scan on the held-out cases through the broker,
 * so an engineer can set its confidence threshold from numbers. For each
 * question, at each threshold from 0.5 to 0.9, it prints the violations the
 * scan would miss, its false alarms and its warnings; the answers the quote
 * check drops; and the same counts with every case asked, which reads the
 * model apart from the candidate rules. It changes nothing: the scan stays
 * off, and no threshold is set in code.
 *
 * The prompts and the model live in the backend, so it calls the route a
 * worker calls. It needs:
 *   DECISION_SCAN_URL            the deployment's HTTP actions origin
 *                                (https://<deployment>.convex.site), where
 *                                READINESS_DECISION_SCAN_ENABLED=1 is set
 *   DECISION_SCAN_SERVICE_TOKEN  that deployment's Inspector service token
 *   DECISION_SCAN_RUNS           `claude:<runId>:<jobId>` and
 *                                `openai:<runId>:<jobId>` entries, one leased
 *                                run per request of up to 24 questions: runs
 *                                started with model observations that no
 *                                worker is executing. It says how many.
 *
 *   npm run measure:decision-scan -w @mcpjam/sdk [-- --out answers.json]
 *
 * MCPJam pays for every question. A run answers once and replays that answer,
 * so measuring again with the same runs costs nothing. Never in CI or tests.
 */

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type {
  DirectoryDecisionAnswer,
  DirectoryDecisionDirectory,
} from "../src/directory-readiness/decisions/index.js";
import {
  loadHeldOutCases,
  measurementBatches,
  measurementItems,
  scoreMeasurement,
  type MeasuredItem,
  type QuestionScore,
} from "./decision-scan-held-out.js";

const DECISIONS_PATH = "/internal/v1/claude-readiness/decisions";
const HEARTBEAT_PATH = "/internal/v1/claude-readiness/runs/heartbeat";
/** A full pass is six rounds of four questions at 30 seconds at worst. */
const REQUEST_TIMEOUT_MS = 5 * 60_000;
/** Well inside the backend's ten-minute lease. */
const HEARTBEAT_EVERY_MS = 60_000;
const ORIGIN = /^(?:https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1)[:/]?)/;
const LEASE = /^(claude|openai):([^:]+):([^:]+)$/;

export interface MeasurementRun {
  directory: DirectoryDecisionDirectory;
  runId: string;
  jobId: string;
}

export type MeasurementConfig =
  | { ok: true; url: string; token: string; runs: MeasurementRun[] }
  | { ok: false; problems: string[] };

/** What the environment gives, or every reason it cannot run. */
export function measurementConfig(
  env: Readonly<Record<string, string | undefined>>
): MeasurementConfig {
  const url = (env.DECISION_SCAN_URL ?? "").replace(/\/+$/, "");
  const token = env.DECISION_SCAN_SERVICE_TOKEN ?? "";
  const entries = (env.DECISION_SCAN_RUNS ?? "").split(/[\s,]+/);
  const runs = entries.flatMap((entry): MeasurementRun[] => {
    const [, directory, runId, jobId] = LEASE.exec(entry) ?? [];
    const known = directory === "claude" || directory === "openai";
    return known && runId && jobId ? [{ directory, runId, jobId }] : [];
  });
  const problems = [
    Boolean(env.CI || env.VITEST) &&
      "The measurement calls MCPJam's paid decision model, so it does not run in CI or tests.",
    !ORIGIN.test(url) &&
      "Set DECISION_SCAN_URL to the deployment's HTTP actions origin, such as https://<deployment>.convex.site.",
    token.length < 16 &&
      "Set DECISION_SCAN_SERVICE_TOKEN to that deployment's Inspector service token.",
    (runs.length === 0 || runs.length < entries.filter(Boolean).length) &&
      "Set DECISION_SCAN_RUNS to leased readiness runs started with model observations, each as claude:<runId>:<jobId> or openai:<runId>:<jobId>.",
  ].filter((problem) => typeof problem === "string");
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, url, token, runs };
}

type Config = Extract<MeasurementConfig, { ok: true }>;
type Reply = { status: number; body: Record<string, unknown> };

async function post(config: Config, path: string, body: unknown, ms: number) {
  const response = await fetch(`${config.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-inspector-service-token": config.token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON, as from a proxy's error page: its start is shown instead.
  }
  const json = typeof parsed === "object" && parsed !== null;
  const reply: Reply = {
    status: response.status,
    body: json ? (parsed as Reply["body"]) : { error: text.slice(0, 200) },
  };
  return reply;
}

/** Whether the run is still leased; a failed call counts as no. */
async function heartbeat(config: Config, { runId, jobId }: MeasurementRun) {
  try {
    const lease = { runId, jobId };
    const reply = await post(config, HEARTBEAT_PATH, lease, 10_000);
    return reply.status === 401 ? "unauthorized" : reply.body.alive === true;
  } catch (error) {
    process.stderr.write(`Heartbeat for run ${runId} failed: ${error}\n`);
    return false;
  }
}

function isAnswer(value: unknown): value is DirectoryDecisionAnswer {
  const answer = value as Partial<DirectoryDecisionAnswer> | null;
  return (
    typeof answer?.questionId === "string" &&
    typeof answer.candidateKey === "string" &&
    typeof answer.verdict === "string" &&
    typeof answer.quote === "string" &&
    typeof answer.confidence === "number"
  );
}

/** One request's answers, or why it has none to keep. */
async function ask(config: Config, run: MeasurementRun, batch: MeasuredItem[]) {
  const items = batch.map(({ item }) => item);
  const lease = { runId: run.runId, jobId: run.jobId };
  const request = { ...lease, items };
  const reply = await post(config, DECISIONS_PATH, request, REQUEST_TIMEOUT_MS);
  const { error = "", detail = "" } = reply.body;
  if (reply.status !== 200) {
    return {
      problem: `refused with ${reply.status} ${error} ${detail}`,
      stop: error === "decisions_disabled",
    };
  }
  const asked = new Set(items.map((i) => `${i.questionId} ${i.candidate.key}`));
  const { decisions } = reply.body;
  const answers = (Array.isArray(decisions) ? decisions : []).filter(isAnswer);
  if (answers.some((a) => !asked.has(`${a.questionId} ${a.candidateKey}`))) {
    return {
      problem:
        "it replayed answers to other questions, asked before the cases changed. Start a new run for it.",
      stop: false,
    };
  }
  return { answers, body: reply.body };
}

const listed = (ids: readonly string[]) =>
  ids.length === 0 ? "0" : `${ids.length} (${ids.join(" ")})`;

function report(scores: readonly QuestionScore[]): string {
  return scores
    .flatMap((score) => [
      `${score.questionId}: ${score.violations} violations, ${score.benign} benign`,
      `  rules proposed ${score.proposed.violations} violations and ${score.proposed.benign} benign; quote check dropped ${listed(score.dropped)}; unanswered ${listed(score.unanswered)}`,
      ...score.thresholds.map(
        (row) =>
          `  at ${row.threshold.toFixed(1)}: missed ${listed(row.missed)}; false alarms ${listed(row.falseAlarms)}; warnings ${listed(row.warned)}; asking every case: missed ${row.modelMissed.length}, false alarms ${row.modelFalseAlarms.length}`
      ),
      "",
    ])
    .join("\n");
}

async function main(): Promise<number> {
  const say = (line: string) => process.stderr.write(`${line}\n`);
  const config = measurementConfig(process.env);
  if (!config.ok) {
    say(config.problems.join("\n"));
    return 1;
  }
  const cases = loadHeldOutCases();
  const items = measurementItems(cases);
  const batches = measurementBatches(items);
  const count = (list: readonly { directory: string }[], directory: string) =>
    list.filter((entry) => entry.directory === directory).length;
  const need = (["claude", "openai"] as const).map((directory) => ({
    directory,
    wanted: count(batches, directory),
    listed: count(config.runs, directory),
  }));
  if (need.some(({ wanted, listed }) => listed < wanted)) {
    const runs = need.map(
      (d) => `${d.wanted} ${d.directory} runs (${d.listed} listed)`
    );
    say(
      `${items.length} questions need ${runs.join(" and ")}. Start the missing leased runs with model observations and add them to DECISION_SCAN_RUNS.`
    );
    return 1;
  }
  const spare = [...config.runs];
  const plan = batches.map((batch) => {
    const at = spare.findIndex((run) => run.directory === batch.directory);
    return { ...batch, run: spare.splice(at, 1)[0] };
  });
  // A run that already answered replays without a lease, so a lapsed one is
  // reported and left for the broker to refuse or replay.
  for (const { run } of plan) {
    const alive = await heartbeat(config, run);
    if (alive === "unauthorized") {
      say(
        `The deployment at DECISION_SCAN_URL refused DECISION_SCAN_SERVICE_TOKEN. Set the token of that deployment.`
      );
      return 1;
    }
    if (!alive) {
      say(
        `Run ${run.runId} is no longer leased to job ${run.jobId}; it can only replay an answer it already gave.`
      );
    }
  }
  const waiting = new Set(plan.map(({ run }) => run));
  const keepAlive = setInterval(() => {
    for (const run of waiting) void heartbeat(config, run);
  }, HEARTBEAT_EVERY_MS);

  const answers: DirectoryDecisionAnswer[] = [];
  const passes: Record<string, unknown>[] = [];
  try {
    for (const [index, { run, items: batch }] of plan.entries()) {
      const at = `Request ${index + 1} of ${plan.length} (${run.directory} run ${run.runId})`;
      const reply = await ask(config, run, batch).catch((error: unknown) => ({
        problem: `failed (${error}). The run may still finish its pass: measuring again with the same runs replays it.`,
        stop: false,
      }));
      waiting.delete(run);
      if ("problem" in reply) {
        say(`${at} ${reply.problem}`);
        if (reply.stop) return 1;
        continue;
      }
      answers.push(...reply.answers);
      const { status, modelId, promptVersion, replayed } = reply.body;
      const answered = reply.answers.length;
      const pass = {
        runId: run.runId,
        status,
        modelId,
        promptVersion,
        answered,
      };
      passes.push(pass);
      process.stdout.write(
        `${at}: ${answered} of ${batch.length} answered, ${status}${replayed ? ", replayed" : ""}, model ${modelId ?? "unknown"}, prompt version ${promptVersion}\n`
      );
    }
  } finally {
    clearInterval(keepAlive);
  }

  process.stdout.write(`\n${report(scoreMeasurement(cases, items, answers))}`);
  const out = process.argv.indexOf("--out");
  const file = out > 0 ? process.argv[out + 1] : undefined;
  const record = JSON.stringify({ passes, items, answers }, null, 2);
  if (file) writeFileSync(file, `${record}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
