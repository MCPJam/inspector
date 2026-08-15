import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import {
  createEvalCaseOperation,
  createEvalSuiteOperation,
  deleteEvalCaseOperation,
  deleteEvalSuiteOperation,
  generateEvalCasesOperation,
  getEvalCaseOperation,
  cancelEvalRunOperation,
  getEvalIterationTraceOperation,
  getEvalRunOperation,
  getEvalRunStepsOperation,
  getEvalSuiteOperation,
  listEvalCasesOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  PlatformApiError,
  resolveProject,
  runEvalCaseOperation,
  runEvalSuiteOperation,
  setEvalSuiteEnvironmentsOperation,
  setEvalSuiteScheduleOperation,
  updateEvalCaseOperation,
  updateEvalSuiteOperation,
  type CreateEvalSuiteInput,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import { JsonInputContext } from "../lib/json-input.js";
import {
  type RenderedScreenshot,
  extractRenderedScreenshots,
  extractIterationVideoUrl,
  screenshotFilename,
} from "../lib/eval-screenshots.js";
import {
  cliError,
  operationalError,
  setProcessExitCode,
  usageError,
  writeResult,
} from "../lib/output.js";
import {
  buildCorpus,
  buildRunCompareReport,
  calculateLatencyStats,
  detectFlakyCases,
  evaluateCompareGates,
  formatGateReport,
  HostedOnlyCaseError,
  verifyCorpusLock,
  type FlakyCase,
  type GateReport,
  type LoadedCorpus,
  type PublicMatchOptions,
  type StructuredRunReport,
} from "@mcpjam/sdk";
import type {
  PlatformEvalCase,
  PlatformEvalIteration,
  PlatformRunCompare,
} from "@mcpjam/sdk/platform";
import {
  CORPUS_DRIFT_EXIT_CODE,
  CORPUS_INCOMPLETE_EXIT_CODE,
  CORPUS_USAGE_EXIT_CODE,
  corpusFetchFailure,
  DEFAULT_CORPUS_LOCK_PATH,
  readCorpusLock,
  renderCorpusDrift,
  resolveCorpusLockPath,
  writeCorpusLockAtomic,
} from "../lib/corpus-lock.js";
import {
  EVAL_GATE_INCOMPLETE_EXIT_CODE,
  EVAL_GATE_USAGE_EXIT_CODE,
  TERMINAL_RUN_STATUSES,
  evalGateExitCode,
  isNonVerdictRunStatus,
} from "../lib/eval-gate-exit-code.js";
import {
  policyFromOptions,
  policyNeedsIterations,
  reportForRun,
  type EvalGateOptions,
} from "../lib/eval-gate.js";
import { fetchAllIterations } from "../lib/eval-iterations.js";
import {
  comparePolicyFromOptions,
  compareGateInputFrom,
  flakyInputFrom,
  type EvalCompareOptions,
} from "../lib/eval-compare.js";
import {
  parseReporterFormat,
  writeJsonArtifact,
  writeReporterResult,
} from "../lib/reporting.js";
import { DEFAULT_PLATFORM_ORIGIN } from "../lib/platform-auth.js";
import {
  buildPlatformClient,
  toCliError,
  webOriginForApiBaseUrl,
} from "../lib/platform-client.js";
import { getGlobalOptions, parsePositiveInteger } from "../lib/server-config.js";
import {
  detectInlineImageProtocol,
  encodeInlineImage,
} from "../lib/terminal-image.js";

type PlatformOptions = {
  apiKey?: string;
  apiUrl?: string;
};

type CreateOptions = PlatformOptions & {
  project?: string;
  file?: string;
  json?: string;
  name?: string;
  model?: string;
  provider?: string;
  server?: string[];
};

function addPlatformOptions(command: Command): Command {
  return command
    .option("--api-key <key>", "MCPJam sk_ API key (overrides MCPJAM_API_KEY)")
    .option(
      "--api-url <url>",
      "MCPJam API base URL (defaults to https://app.mcpjam.com/api/v1)"
    );
}

/**
 * Print a deep link to a run, after the command's own machine-readable
 * output.
 *
 * HUMAN FORMAT ONLY, and written separately rather than folded into
 * `writeResult`: that helper is format-generic and its `--format json` bytes
 * are a contract scripts parse. A trailing prose line would break every one
 * of them, so the gate lives here at the call site.
 *
 * The route is the unflagged `/evals/suite/:suiteId/runs/:runId` — the
 * `/ci-evals` twin is behind the `evaluate-ci` flag and its redirect drops
 * the run path.
 */
function writeRunLink(
  format: string,
  webOrigin: string,
  run: { projectId?: string; suiteId?: string; runId?: string }
): void {
  if (format !== "human") return;
  const suiteId = run.suiteId?.trim();
  const runId = run.runId?.trim();
  if (!suiteId || !runId) return;
  const query = run.projectId?.trim()
    ? `?project=${encodeURIComponent(run.projectId.trim())}`
    : "";
  process.stdout.write(
    `View: ${webOrigin}/evals/suite/${encodeURIComponent(
      suiteId
    )}/runs/${encodeURIComponent(runId)}${query}\n`
  );
}

async function runPlatformCommand<TOutput>(
  options: PlatformOptions,
  timeoutMs: number,
  execute: (context: {
    client: ReturnType<typeof buildPlatformClient>["client"];
    signal: AbortSignal;
    /** App origin matching the API base this call went to. */
    webOrigin: string;
  }) => Promise<TOutput>
): Promise<TOutput> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(
      new PlatformApiError(
        `Request timed out after ${timeoutMs}ms`,
        "TIMEOUT",
        {
          status: 0,
        }
      )
    );
  }, timeoutMs);
  timeoutHandle.unref?.();

  try {
    const { client, baseUrl } = buildPlatformClient({ ...options, timeoutMs });
    return await execute({
      client,
      signal: controller.signal,
      webOrigin: webOriginForApiBaseUrl(baseUrl),
    });
  } catch (error) {
    if (
      controller.signal.aborted &&
      controller.signal.reason instanceof PlatformApiError
    ) {
      throw toCliError(controller.signal.reason);
    }
    throw toCliError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Read a suite definition file by literal path (or `-` for stdin). Unlike the
 * `@file` convention in json-input.ts, `--file` points at a real path — the
 * common affordance for a JSON document on disk.
 */
function readFileOrStdin(value: string, label: string): string {
  try {
    return value === "-"
      ? readFileSync(0, "utf8")
      : readFileSync(value, "utf8");
  } catch (error) {
    throw usageError(`Failed to read ${label} "${value}".`, {
      source: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Build the create_eval_suite input from a JSON suite definition (via --file
 * or --json) plus scalar flag overrides, then validate it against the
 * operation's own schema so errors surface as usage errors before any network
 * call.
 */
function loadSuiteDefinition(options: CreateOptions): CreateEvalSuiteInput {
  if (options.file !== undefined && options.json !== undefined) {
    throw usageError("Provide either --file or --json, not both.");
  }

  let base: unknown = {};
  if (options.file !== undefined) {
    const text = readFileOrStdin(options.file, "--file");
    if (text.trim() === "") {
      throw usageError("--file input is empty.");
    }
    try {
      base = JSON.parse(text);
    } catch (error) {
      throw usageError("--file must contain valid JSON.", {
        source: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (options.json !== undefined) {
    base = new JsonInputContext().parseJsonInputRecord(options.json, "--json");
  }

  if (base === undefined || base === null) {
    base = {};
  }
  if (typeof base !== "object" || Array.isArray(base)) {
    throw usageError("Suite definition must be a JSON object.");
  }

  const merged = {
    ...(base as Record<string, unknown>),
    ...(options.project !== undefined ? { project: options.project } : {}),
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.server !== undefined ? { servers: options.server } : {}),
  };

  const parsed = createEvalSuiteOperation.inputSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw usageError(`Invalid suite definition: ${detail}`);
  }
  return parsed.data;
}

/** Read a partial JSON body object from --file / --json (or {} when absent). */
function loadBodyObject(options: {
  file?: string;
  json?: string;
}): Record<string, unknown> {
  if (options.file !== undefined && options.json !== undefined) {
    throw usageError("Provide either --file or --json, not both.");
  }
  let base: unknown = {};
  if (options.file !== undefined) {
    const text = readFileOrStdin(options.file, "--file");
    if (text.trim() === "") throw usageError("--file input is empty.");
    try {
      base = JSON.parse(text);
    } catch (error) {
      throw usageError("--file must contain valid JSON.", {
        source: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (options.json !== undefined) {
    base = new JsonInputContext().parseJsonInputRecord(options.json, "--json");
  }
  if (base === undefined || base === null) base = {};
  if (typeof base !== "object" || Array.isArray(base)) {
    throw usageError("Body must be a JSON object.");
  }
  return base as Record<string, unknown>;
}

/** Validate a merged input object against an operation's schema (usage error on failure). */
function validateOpInput<TInput>(
  op: PlatformOperation<TInput, unknown>,
  raw: unknown
): TInput {
  const parsed = op.inputSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw usageError(`Invalid input: ${detail}`);
  }
  return parsed.data;
}

/** Run an operation with a pre-validated input and print the result. */
async function executeOp<TInput, TOutput>(
  op: PlatformOperation<TInput, TOutput>,
  input: TInput,
  options: PlatformOptions,
  command: Command
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const result = await runPlatformCommand(
    options,
    globalOptions.timeout,
    ({ client, signal }) => op.execute(input, { client, signal })
  );
  writeResult(result, globalOptions.format);
}

/** Merge `eval update` flags onto an optional --file/--json suite-update body. */
function buildSuiteUpdateInput(
  options: Record<string, any>
): Record<string, unknown> {
  const input: Record<string, any> = { ...loadBodyObject(options) };
  input.suite = options.suite;
  if (options.project !== undefined) input.project = options.project;
  if (options.name !== undefined) input.name = options.name;
  if (options.description !== undefined)
    input.description = options.description;
  if (options.server !== undefined)
    input.environment = {
      ...(input.environment ?? {}),
      servers: options.server,
    };
  if (options.host !== undefined)
    input.hosts = options.host.map((host: string) => ({ host }));

  const exec = { ...(input.executionConfig ?? {}) };
  if (options.model !== undefined) exec.model = options.model;
  if (options.systemPrompt !== undefined)
    exec.systemPrompt = options.systemPrompt;
  if (options.temperature !== undefined)
    exec.temperature = Number(options.temperature);
  if (Object.keys(exec).length > 0) input.executionConfig = exec;

  const settings = { ...(input.settings ?? {}) };
  if (options.minAccuracy !== undefined)
    settings.minimumAccuracy = Number(options.minAccuracy);
  const mo = { ...(settings.matchOptions ?? {}) };
  if (options.toolCallOrder !== undefined)
    mo.toolCallOrder = options.toolCallOrder;
  if (options.arguments !== undefined) mo.arguments = options.arguments;
  if (options.extraToolCalls !== undefined)
    mo.extraToolCalls =
      options.extraToolCalls === "unlimited"
        ? "unlimited"
        : Number(options.extraToolCalls);
  if (Object.keys(mo).length > 0) settings.matchOptions = mo;
  const judge = { ...(settings.judge ?? {}) };
  if (options.judge !== undefined) {
    if (options.judge !== "on" && options.judge !== "off") {
      throw usageError('--judge must be "on" or "off".');
    }
    judge.enabled = options.judge === "on";
  }
  if (options.judgeModel !== undefined) judge.model = options.judgeModel;
  if (Object.keys(judge).length > 0) settings.judge = judge;
  if (Object.keys(settings).length > 0) input.settings = settings;

  return input;
}

/** Merge a --file/--json case body with the selectors (+ optional --title). */
function buildCaseInput(
  options: Record<string, any>,
  opts: { requireCase: boolean }
): Record<string, unknown> {
  const input: Record<string, any> = { ...loadBodyObject(options) };
  if (options.project !== undefined) input.project = options.project;
  input.suite = options.suite;
  if (opts.requireCase) input.case = options.case;
  if (options.title !== undefined) input.title = options.title;
  return input;
}

/** A screenshot entry as emitted in JSON output (and after an optional save). */
type ScreenshotItem = RenderedScreenshot & { savedTo?: string };

/**
 * Fetch raw artifact bytes (screenshot PNG or replay `.webm`) for a resolved
 * URL, bounded by the request timeout. `kind` only shapes the error wording.
 */
async function fetchArtifactBytes(
  url: string,
  timeoutMs: number,
  kind = "screenshot"
): Promise<Uint8Array> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  handle.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw operationalError(
        `Failed to download ${kind} (HTTP ${response.status}).`,
        { url }
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw operationalError(
        `Timed out downloading ${kind} after ${timeoutMs}ms.`,
        { url }
      );
    }
    throw error;
  } finally {
    clearTimeout(handle);
  }
}

/** Fetch raw image bytes for a screenshot URL, bounded by the request timeout. */
function fetchScreenshotBytes(
  url: string,
  timeoutMs: number
): Promise<Uint8Array> {
  return fetchArtifactBytes(url, timeoutMs, "screenshot");
}

/**
 * Resolve where a screenshot should be written for `--out`. A path that is (or
 * looks like) a directory gets a generated per-render filename; otherwise the
 * literal path is used — but only when saving a single image, so multiple
 * renders never overwrite one file.
 */
function resolveScreenshotPath(
  out: string,
  shot: RenderedScreenshot,
  index: number,
  total: number
): string {
  const looksLikeDir =
    out.endsWith("/") || (existsSync(out) && statSync(out).isDirectory());
  if (looksLikeDir) {
    return join(out, screenshotFilename(shot, index));
  }
  if (total > 1) {
    throw usageError(
      "--out must be a directory when the iteration rendered multiple screenshots."
    );
  }
  return out;
}

/** Commander collector for a repeatable `--flag value` option. */
function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const DEFAULT_GATE_WAIT_TIMEOUT_MS = 600_000;

async function runEvalGate(
  options: PlatformOptions &
    EvalGateOptions & {
      project: string;
      run: string;
      wait?: boolean;
      waitTimeout?: string;
      /**
       * Commander models `--no-gating-score-errors` as the NEGATION of an
       * implicit `--gating-score-errors`, so the field is `gatingScoreErrors`
       * and it is `false` exactly when the user passed the flag. Reading it any
       * other way silently enables the gate on every invocation.
       */
      gatingScoreErrors?: boolean;
    },
  command: Command
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const policy = policyFromOptions({
    ...options,
    noGatingScoreErrors: options.gatingScoreErrors === false,
  });
  const waitTimeoutMs =
    options.waitTimeout !== undefined
      ? parsePositiveInteger(options.waitTimeout, "--wait-timeout")
      : DEFAULT_GATE_WAIT_TIMEOUT_MS;

  let report: GateReport;
  try {
    report = await runPlatformCommand(
      options,
      Math.max(globalOptions.timeout, options.wait ? waitTimeoutMs : 0),
      async ({ client, signal }) => {
        const projects = await client.listProjects({}, { signal });
        const resolution = resolveProject(projects.items, options.project);
        if (!resolution.ok) {
          throw usageError(resolution.message);
        }
        const project = resolution.project;
        const deadline = Date.now() + waitTimeoutMs;
        let run = await client.getEvalRun(
          { projectId: project.id, runId: options.run },
          { signal }
        );

        while (!TERMINAL_RUN_STATUSES.has(run.status)) {
          if (!options.wait) {
            // Without --wait, a still-running run would otherwise be gated on
            // its PARTIAL summary — a confident verdict about an unfinished
            // run. Undecidable, not failed.
            return {
              outcome: "incomplete" as const,
              scoreIntegrity: "unknown" as const,
              verdicts: [
                {
                  gate: "run",
                  status: "non_gateable" as const,
                  message: `run is ${run.status}; pass --wait, or gate it once it finishes`,
                },
              ],
            };
          }
          if (Date.now() >= deadline) {
            // A wait timeout is INFRASTRUCTURE, not a verdict: the run may yet
            // pass. Reported as incomplete so it can never read as a
            // regression.
            return {
              outcome: "incomplete" as const,
              scoreIntegrity: "unknown" as const,
              verdicts: [
                {
                  gate: "wait",
                  status: "non_gateable" as const,
                  message: `run still ${run.status} after ${waitTimeoutMs}ms`,
                },
              ],
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 3000));
          run = await client.getEvalRun(
            { projectId: project.id, runId: options.run },
            { signal }
          );
        }

        if (isNonVerdictRunStatus(run.status)) {
          // Cancelled / timed out: the run has not told us the server
          // regressed, it has told us nothing.
          return {
            outcome: "incomplete" as const,
            scoreIntegrity: "unknown" as const,
            verdicts: [
              {
                gate: "run",
                status: "non_gateable" as const,
                message: `run is ${run.status}; no verdict was established`,
              },
            ],
          };
        }

        const iterations = policyNeedsIterations(policy)
          ? await fetchAllIterations(client, signal, project.id, options.run)
          : undefined;
        return reportForRun(run, iterations, policy);
      }
    );
  } catch (error) {
    // A USAGE error (bad project selector, malformed flag) is the author's
    // mistake and keeps its own exit code — mapping it to 3 would tell a CI
    // operator to go looking for an outage that never happened.
    if (
      error instanceof Error &&
      (error as { exitCode?: number }).exitCode === EVAL_GATE_USAGE_EXIT_CODE
    ) {
      throw error;
    }
    // Everything else — network, auth, timeout — is infrastructure. NEVER exit
    // 1: a CI job that fails a release on a flaked request, and calls it a
    // regression, teaches people to ignore the gate.
    const detail = error instanceof Error ? error.message : String(error);
    writeResult(
      {
        gate: {
          outcome: "incomplete",
          scoreIntegrity: "unknown",
          verdicts: [
            {
              gate: "fetch",
              status: "non_gateable",
              message: `could not read the run: ${detail}`,
            },
          ],
        },
        exitCode: EVAL_GATE_INCOMPLETE_EXIT_CODE,
      },
      globalOptions.format
    );
    setProcessExitCode(EVAL_GATE_INCOMPLETE_EXIT_CODE);
    return;
  }

  const exitCode = evalGateExitCode(report);
  writeResult({ gate: report, exitCode }, globalOptions.format);
  if (globalOptions.format === "human") {
    process.stderr.write(`${formatGateReport(report)}\n`);
  }
  if (exitCode !== 0) {
    setProcessExitCode(exitCode);
  }
}

/**
 * `mcpjam eval compare` — this run against a baseline.
 *
 * Deliberately has NO `--wait`. A comparison against a run that has not
 * finished compares against a partial population, and the honest answer is
 * incomplete (exit 3), not "wait around and hope". `eval gate --wait` exists
 * for the waiting.
 */
async function runEvalCompare(
  options: PlatformOptions &
    EvalCompareOptions & {
      project: string;
      run: string;
      baseRun?: string;
      reporter?: string;
      out?: string;
    },
  command: Command
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  // Parsed BEFORE any network call, so a malformed flag exits 2 without
  // spending a request — and cannot be mistaken for an infrastructure failure.
  const policy = comparePolicyFromOptions(options);
  const reporter = parseReporterFormat(options.reporter);

  type CompareOutcome = {
    report: GateReport;
    compare?: PlatformRunCompare;
    flakyCases?: FlakyCase[];
  };

  let outcome: CompareOutcome;
  try {
    outcome = await runPlatformCommand(
      options,
      globalOptions.timeout,
      async ({ client, signal }) => {
        const projects = await client.listProjects({}, { signal });
        const resolution = resolveProject(projects.items, options.project);
        if (!resolution.ok) {
          throw usageError(resolution.message);
        }
        const project = resolution.project;

        const compare = await client.compareEvalRun(
          {
            projectId: project.id,
            runId: options.run,
            ...(options.baseRun ? { baseRunId: options.baseRun } : {}),
          },
          { signal }
        );

        // Latency and flakiness both need per-iteration rows. An INCOMPLETE
        // walk contributes neither: a p95 over page one is not this run's p95,
        // and a flaky-case list from a sample is misleading rather than
        // partial.
        const needsIterations =
          policy.maximumP95LatencyIncreaseMs !== undefined;
        const [baseIterations, compareIterations] = needsIterations
          ? await Promise.all([
              fetchAllIterations(
                client,
                signal,
                project.id,
                compare.baseRun.id
              ),
              fetchAllIterations(
                client,
                signal,
                project.id,
                compare.compareRun.id
              ),
            ])
          : [
              undefined,
              await fetchAllIterations(
                client,
                signal,
                project.id,
                compare.compareRun.id
              ),
            ];

        // Defence in depth. The backend action already refuses a
        // non-completed run, so this is normally unreachable — but the
        // command's contract says an unfinished comparison is INCOMPLETE, and
        // that must not depend on a guard in another repo staying put.
        if (
          compare.baseRun.completedAt === null ||
          compare.compareRun.completedAt === null
        ) {
          return {
            report: {
              outcome: "incomplete" as const,
              scoreIntegrity: "unknown" as const,
              verdicts: [
                {
                  gate: "run",
                  status: "non_gateable" as const,
                  message:
                    "both runs must be completed before they can be compared",
                },
              ],
            },
            compare,
            flakyCases: [],
          };
        }

        const input = compareGateInputFrom(compare, {
          baseP95Ms: p95Of(baseIterations),
          compareP95Ms: p95Of(compareIterations),
        });

        return {
          report: evaluateCompareGates(input, policy),
          compare,
          // Reported, NEVER gated. See `detectFlakyCases`.
          flakyCases: compareIterations?.complete
            ? detectFlakyCases(flakyInputFrom(compareIterations.items))
            : [],
        };
      }
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error as { exitCode?: number }).exitCode === EVAL_GATE_USAGE_EXIT_CODE
    ) {
      throw error;
    }
    // A missing baseline is INCOMPLETE, not a failure: the run may be a
    // suite's first, and reporting exit 1 would claim a regression nobody
    // observed. Keyed on `details.reason` rather than the message, which is
    // prose and may be localized or reworded.
    const reason = baselineNotFoundReason(error);
    const detail = error instanceof Error ? error.message : String(error);
    const report: GateReport = {
      outcome: "incomplete",
      scoreIntegrity: "unknown",
      verdicts: [
        {
          gate: reason ? "baseline" : "fetch",
          status: "non_gateable",
          message: reason
            ? `no baseline to compare against: ${detail}`
            : `could not compare the runs: ${detail}`,
        },
      ],
    };
    // A reporter was requested, so CI is parsing the output — handing it the
    // default JSON instead of JUnit on the error path is how a pipeline
    // silently stops seeing results.
    await writeCompareResult(
      { report, reporter, out: options.out, format: globalOptions.format },
      // Built whenever EITHER output channel was requested. `--reporter` needs
      // it to emit JUnit rather than JSON; `--out` needs it so a CI step
      // reading the artifact finds the verdict instead of a missing file.
      reporter || options.out ? emptyCompareReport(report) : undefined
    );
    setProcessExitCode(EVAL_GATE_INCOMPLETE_EXIT_CODE);
    return;
  }

  const exitCode = evalGateExitCode(outcome.report);
  await writeCompareResult(
    {
      report: outcome.report,
      reporter,
      out: options.out,
      format: globalOptions.format,
    },
    outcome.compare
      ? buildRunCompareReport(outcome.compare, outcome.report, {
          flakyCases: outcome.flakyCases,
        })
      : undefined
  );
  if (globalOptions.format === "human" && !reporter) {
    process.stderr.write(`${formatGateReport(outcome.report)}\n`);
  }
  if (exitCode !== 0) {
    setProcessExitCode(exitCode);
  }
}

/**
 * `mcpjam eval pull` — materialize a hosted suite into a local corpus lock.
 *
 * Two modes, one code path. The default fetches and WRITES the lock; `--frozen`
 * fetches and only COMPARES, never writing. Sharing the fetch and
 * materialization matters: a `--frozen` check that built its corpus differently
 * from the pull that wrote the lock would report drift that does not exist.
 *
 * Exit codes follow the contract in `corpus-lock.ts`: 0 clean, 1 drift (the one
 * real verdict this command can reach), 2 a flag or a case this CLI cannot run,
 * 3 anything that means no comparison happened.
 */
async function runEvalPull(
  options: PlatformOptions & {
    suite: string;
    project?: string;
    lock?: string;
    frozen?: boolean;
    skipUnsupported?: boolean;
  },
  command: Command
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const lockPath = resolveCorpusLockPath(options.lock);

  // Read the existing lock BEFORE fetching. A `--frozen` run with no lock is
  // exit 3 whatever the server would have said, and discovering that after a
  // round trip only delays the answer.
  const locked = options.frozen ? await readCorpusLock(lockPath) : undefined;

  let fetched: {
    suite: { id: string; name?: string };
    cases: PlatformEvalCase[];
    suiteChecks: unknown[];
    suiteMatchOptions?: PublicMatchOptions;
  };
  try {
    fetched = await runPlatformCommand(
      options,
      globalOptions.timeout,
      async ({ client, signal }) => {
        const selector = {
          ...(options.project ? { project: options.project } : {}),
          suite: options.suite,
        };
        const [detail, page] = await Promise.all([
          getEvalSuiteOperation.execute(selector, { client, signal }),
          listEvalCasesOperation.execute(selector, { client, signal }),
        ]);

        // The cases endpoint returns the whole suite today and the client has
        // no cursor parameter to follow one with. If that ever changes, a
        // silently truncated corpus would be locked as if complete — so this
        // refuses rather than guessing. Fail-closed: a partial lock is worse
        // than no lock.
        if (page.nextCursor) {
          throw cliError(
            "CORPUS_TRUNCATED",
            `Suite "${options.suite}" returned more cases than one page and ` +
              `this CLI cannot follow the cursor. Upgrade @mcpjam/cli.`,
            CORPUS_INCOMPLETE_EXIT_CODE
          );
        }

        return {
          suite: {
            id: detail.id,
            ...(detail.name ? { name: detail.name } : {}),
          },
          cases: page.items,
          suiteChecks: detail.settings.checks ?? [],
          ...(detail.settings.matchOptions
            ? { suiteMatchOptions: detail.settings.matchOptions }
            : {}),
        };
      }
    );
  } catch (error) {
    throw corpusFetchFailure(error);
  }

  let corpus: LoadedCorpus;
  try {
    corpus = buildCorpus({
      ...(options.project ? { project: options.project } : {}),
      suite: fetched.suite,
      cases: fetched.cases,
      suiteChecks: fetched.suiteChecks,
      ...(fetched.suiteMatchOptions
        ? { suiteMatchOptions: fetched.suiteMatchOptions }
        : {}),
      unsupported: options.skipUnsupported ? "skip" : "error",
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    // A case this CLI cannot execute is the user's to resolve — by fixing the
    // case, or by opting into `--skip-unsupported`. It is emphatically NOT
    // exit 1: nothing regressed. Nor exit 3: the fetch succeeded and the
    // answer is definite.
    if (error instanceof HostedOnlyCaseError) {
      throw cliError(
        "CORPUS_HOSTED_ONLY_CASE",
        `${error.message} Pass --skip-unsupported to omit cases like this ` +
          `from the corpus and the lock.`,
        CORPUS_USAGE_EXIT_CODE,
        { caseId: error.caseId, caseTitle: error.caseTitle }
      );
    }
    throw cliError(
      "CORPUS_INVALID_CASE",
      error instanceof Error ? error.message : String(error),
      CORPUS_USAGE_EXIT_CODE
    );
  }

  const summary = {
    suite: corpus.suite,
    cases: corpus.cases.length,
    skipped: corpus.skipped,
    evaluationConfigHash: corpus.lock.evaluationConfigHash,
  };

  if (locked) {
    const drift = verifyCorpusLock(locked, corpus.lock);
    writeResult(
      { ...summary, lockPath, frozen: true, drift },
      globalOptions.format
    );
    if (globalOptions.format === "human") {
      process.stderr.write(`${renderCorpusDrift(drift)}\n`);
    }
    if (drift.length > 0) {
      setProcessExitCode(CORPUS_DRIFT_EXIT_CODE);
    }
    return;
  }

  const written = await writeCorpusLockAtomic(lockPath, corpus.lock);
  writeResult(
    { ...summary, lockPath: written, written: true },
    globalOptions.format
  );
}

/**
 * A structured report for a comparison that never happened.
 *
 * The gate case alone, so `--reporter junit-xml` still emits well-formed XML
 * whose single failure explains why — rather than an empty suite, which every
 * CI UI renders as "nothing ran".
 */
function emptyCompareReport(report: GateReport): StructuredRunReport {
  return buildRunCompareReport(
    {
      suite: { id: "", name: "" },
      baseline: { policy: "previous_completed", baseRunId: "" },
      baseRun: {
        id: "",
        runNumber: 0,
        result: "",
        createdAt: 0,
        completedAt: null,
        summary: null,
      },
      compareRun: {
        id: "",
        runNumber: 0,
        result: "",
        createdAt: 0,
        completedAt: null,
        summary: null,
      },
      passSummary: {
        passRatePercent: EMPTY_DIFF,
        total: EMPTY_DIFF,
        passed: EMPTY_DIFF,
        failed: EMPTY_DIFF,
      },
      metrics: {
        wallDurationMs: EMPTY_DIFF,
        totalTokens: EMPTY_DIFF,
        estimatedCostUsd: EMPTY_DIFF,
      },
      scoreContract: {
        base: {
          evaluationConfigHash: null,
          scoreIntegrity: null,
          scoredIterations: 0,
          quarantinedIterations: 0,
        },
        compare: {
          evaluationConfigHash: null,
          scoreIntegrity: null,
          scoredIterations: 0,
          quarantinedIterations: 0,
        },
        evaluationConfigChanged: false,
        scorers: [],
      },
      cases: [],
    },
    report
  );
}

const EMPTY_DIFF = {
  base: null,
  compare: null,
  delta: null,
  percentDelta: null,
};

/** p95 over a COMPLETE iteration walk; `undefined` from a partial one. */
function p95Of(
  iterations: { items: PlatformEvalIteration[]; complete: boolean } | undefined
): number | undefined {
  if (!iterations?.complete) return undefined;
  const durations = iterations.items
    .map((iteration) => iteration.durationMs)
    .filter((ms): ms is number => typeof ms === "number");
  if (durations.length === 0 || durations.length !== iterations.items.length) {
    // A single missing duration makes the p95 describe a different set than
    // the run — absent beats approximate.
    return undefined;
  }
  return calculateLatencyStats(durations).p95;
}

/**
 * The server says "no baseline" with a 404 carrying
 * `details.reason: "BASELINE_NOT_FOUND"`. Read the machine field, not the
 * prose.
 */
function baselineNotFoundReason(error: unknown): boolean {
  const details = (error as { details?: unknown })?.details;
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { reason?: unknown }).reason === "BASELINE_NOT_FOUND"
  );
}

async function writeCompareResult(
  args: {
    report: GateReport;
    reporter: ReturnType<typeof parseReporterFormat>;
    out?: string;
    format: ReturnType<typeof getGlobalOptions>["format"];
  },
  structured: StructuredRunReport | undefined
): Promise<void> {
  if (args.out && structured) {
    await writeJsonArtifact(args.out, structured);
  }
  if (args.reporter && structured) {
    writeReporterResult(args.reporter, structured);
    return;
  }
  writeResult(
    { compare: args.report, exitCode: evalGateExitCode(args.report) },
    args.format
  );
}

export function registerEvalCommands(program: Command): void {
  const evals = program
    .command("eval")
    .description("Author and run eval suites in your hosted MCPJam projects");

  addPlatformOptions(
    evals
      .command("create")
      .description(
        "Create a runnable eval suite from authored test cases (does not run it)"
      )
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
      .option(
        "--file <path>",
        "Path to a suite definition JSON file (or - for stdin)"
      )
      .option(
        "--json <json>",
        "Inline suite definition JSON (or @file, or - for stdin)"
      )
      .option("--name <name>", "Suite name (overrides the file)")
      .option(
        "--model <model>",
        "Suite-level default model (overrides the file)"
      )
      .option(
        "--provider <provider>",
        "Suite-level default provider (overrides the file; needed for bare/custom model ids)"
      )
      .option(
        "--server <name...>",
        "Project HTTP server names or IDs (overrides the file)"
      )
  ).action(async (options: CreateOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const input = loadSuiteDefinition(options);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        createEvalSuiteOperation.execute(input, { client, signal })
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    evals
      .command("list")
      .description("List the eval suites saved in a project")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
  ).action(async (options: PlatformOptions & { project?: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        listEvalSuitesOperation.execute(
          { project: options.project },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    evals
      .command("runs")
      .description("List a suite's run history, newest first")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
      .option(
        "--limit <n>",
        "Maximum number of runs to return (1-100)",
        (value) => Number.parseInt(value, 10)
      )
  ).action(
    async (
      options: PlatformOptions & {
        suite: string;
        project?: string;
        limit?: number;
      },
      command
    ) => {
      const input = validateOpInput(listEvalSuiteRunsOperation, {
        suite: options.suite,
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      await executeOp(listEvalSuiteRunsOperation, input, options, command);
    }
  );

  addPlatformOptions(
    evals
      .command("run")
      .description("Start an eval run of an existing suite (asynchronous)")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
      .option(
        "--server <id-or-name...>",
        "Override the suite's saved server selection (HTTP servers only)"
      )
      .option(
        "--environment <id-or-name>",
        "Project environment to run against (must be attached to the suite; optional when it has exactly one)"
      )
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        server?: string[];
        environment?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      let webOrigin = DEFAULT_PLATFORM_ORIGIN;
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        (context) => {
          webOrigin = context.webOrigin;
          return runEvalSuiteOperation.execute(
            {
              project: options.project,
              suite: options.suite,
              ...(options.server ? { servers: options.server } : {}),
              ...(options.environment
                ? { environment: options.environment }
                : {}),
            },
            { client: context.client, signal: context.signal }
          );
        }
      );
      writeResult(result, globalOptions.format);
      writeRunLink(globalOptions.format, webOrigin, {
        projectId: result.project.id,
        suiteId: result.suite.id,
        runId: result.runId,
      });
    }
  );

  addPlatformOptions(
    evals
      .command("status")
      .description("Get the status and summary of an eval run")
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & { project: string; run: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      let webOrigin = DEFAULT_PLATFORM_ORIGIN;
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        (context) => {
          webOrigin = context.webOrigin;
          return getEvalRunOperation.execute(
            { project: options.project, runId: options.run },
            { client: context.client, signal: context.signal }
          );
        }
      );
      writeResult(result, globalOptions.format);
      writeRunLink(globalOptions.format, webOrigin, {
        projectId: result.project.id,
        suiteId: result.run.suiteId,
        runId: result.run.id,
      });
    }
  );

  addPlatformOptions(
    evals
      .command("cancel")
      .description(
        "Cancel an in-flight eval run (no-op if already cancelled; errors if it already finished)"
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & { project: string; run: string },
      command
    ) => {
      await executeOp(
        cancelEvalRunOperation,
        { project: options.project, runId: options.run },
        options,
        command
      );
    }
  );

  const PROJECT_OPT = "Project name or ID (defaults to most recently updated)";

  // ── Eval run iterations + traces ───────────────────────────────────
  addPlatformOptions(
    evals
      .command("iterations")
      .description(
        "List per-iteration results for an eval run (pass/fail, tool calls, tokens, latency)"
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption(
        "--project <id-or-name>",
        "Project the run belongs to (name or ID)"
      )
      .option("--cursor <cursor>", "Pagination cursor from a previous response")
      .option("--limit <n>", "Max iterations per page (1–200)")
  ).action(
    async (
      options: PlatformOptions & {
        project: string;
        run: string;
        cursor?: string;
        limit?: string;
      },
      command
    ) => {
      const input = validateOpInput(listEvalRunIterationsOperation, {
        project: options.project,
        runId: options.run,
        ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        ...(options.limit !== undefined ? { limit: Number(options.limit) } : {}),
      });
      await executeOp(listEvalRunIterationsOperation, input, options, command);
    }
  );

  addPlatformOptions(
    evals
      .command("gate")
      .description(
        "Apply a pass/fail policy to a finished eval run and set an exit code (0 pass, 1 eval failure, 2 usage, 3 incomplete)"
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption(
        "--project <id-or-name>",
        "Project the run belongs to (name or ID)"
      )
      .option(
        "--min-pass-rate-percent <0-100>",
        "Minimum share of iterations that must pass, as a percentage"
      )
      .option(
        "--no-gating-score-errors",
        "Fail if any gating scorer errored during the run"
      )
      .option(
        "--min-scorer-pass-rate <scorerId=percent>",
        "Minimum pass rate for one scorer (repeatable)",
        collectRepeatable,
        [] as string[]
      )
      .option(
        "--min-mean-score <scorerId=0..1>",
        "Minimum mean score for one scorer (repeatable)",
        collectRepeatable,
        [] as string[]
      )
      .option("--wait", "Poll until the run reaches a terminal status")
      .option(
        "--wait-timeout <ms>",
        "Give up waiting after this many milliseconds (default 600000)"
      )
  ).action(
    async (
      options: PlatformOptions &
        EvalGateOptions & {
          project: string;
          run: string;
          wait?: boolean;
          waitTimeout?: string;
        },
      command
    ) => {
      await runEvalGate(options, command);
    }
  );

  addPlatformOptions(
    evals
      .command("compare")
      .description(
        "Compare a finished eval run against a baseline and set an exit code (0 pass, 1 regression, 2 usage, 3 incomplete)"
      )
      .requiredOption("--run <id>", "Eval run ID to compare")
      .requiredOption(
        "--project <id-or-name>",
        "Project the run belongs to (name or ID)"
      )
      .option(
        "--base-run <id>",
        "Baseline run ID (defaults to the nearest earlier completed run in the same suite)"
      )
      .option(
        "--gate-regressions",
        "Fail on a statistically significant pass-rate regression"
      )
      .option(
        "--min-sample-size <n>",
        "Iterations required on EACH side before a pass-rate regression is decidable (default 5)"
      )
      .option(
        "--min-effect-size-percent <0-100>",
        "Smallest pass-rate drop worth failing on, as a percentage (default 1)"
      )
      .option(
        "--gate-deterministic-regressions",
        "Fail if a deterministic gating scorer flipped from passed to failed"
      )
      .option(
        "--max-p95-latency-increase-ms <ms>",
        "Fail if p95 end-to-end latency rose by more than this many milliseconds"
      )
      .option(
        "--reporter <json-summary|junit-xml>",
        "Write a structured report to stdout instead of the default output"
      )
      .option("--out <path>", "Write the structured report to a JSON file")
  ).action(
    async (
      options: PlatformOptions &
        EvalCompareOptions & {
          project: string;
          run: string;
          baseRun?: string;
          reporter?: string;
          out?: string;
        },
      command
    ) => {
      await runEvalCompare(options, command);
    }
  );

  addPlatformOptions(
    evals
      .command("pull")
      .description(
        "Materialize a hosted eval suite into a local corpus lock (0 clean, 1 drift under --frozen, 2 usage, 3 incomplete)"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite to pull (name or ID)")
      .option(
        "--project <id-or-name>",
        "Project the suite belongs to (defaults to the most recently updated project)"
      )
      .option(
        "--lock <path>",
        `Lock file path (default ${DEFAULT_CORPUS_LOCK_PATH})`
      )
      .option(
        "--frozen",
        "Verify the lock matches the hosted suite without writing; exit 1 on drift"
      )
      .option(
        "--skip-unsupported",
        "Omit cases a local run cannot execute instead of failing"
      )
  ).action(
    async (
      options: PlatformOptions & {
        suite: string;
        project?: string;
        lock?: string;
        frozen?: boolean;
        skipUnsupported?: boolean;
      },
      command
    ) => {
      await runEvalPull(options, command);
    }
  );

  addPlatformOptions(
    evals
      .command("trace")
      .description(
        "Fetch the full trace for one eval iteration (large: full message history + spans)"
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption(
        "--iteration <id>",
        "Iteration ID (from `eval iterations`)"
      )
      .requiredOption(
        "--project <id-or-name>",
        "Project the run belongs to (name or ID)"
      )
  ).action(
    async (
      options: PlatformOptions & {
        project: string;
        run: string;
        iteration: string;
      },
      command
    ) => {
      await executeOp(
        getEvalIterationTraceOperation,
        {
          project: options.project,
          runId: options.run,
          iterationId: options.iteration,
        },
        options,
        command
      );
    }
  );

  addPlatformOptions(
    evals
      .command("steps")
      .description(
        "Per-authored-step results for one eval iteration: status (ok/fail/skipped/pending), reason, and evidence (screenshot/video URLs). The fastest way to see WHICH step failed and why."
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption(
        "--iteration <id>",
        "Iteration ID (from `eval iterations`)"
      )
      .requiredOption(
        "--project <id-or-name>",
        "Project the run belongs to (name or ID)"
      )
  ).action(
    async (
      options: PlatformOptions & {
        project: string;
        run: string;
        iteration: string;
      },
      command
    ) => {
      await executeOp(
        getEvalRunStepsOperation,
        {
          project: options.project,
          runId: options.run,
          iterationId: options.iteration,
        },
        options,
        command
      );
    }
  );

  addPlatformOptions(
    evals
      .command("screenshot")
      .description(
        "Show the widget screenshot(s) an eval iteration rendered — inline when the terminal supports it, otherwise the image URL"
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption(
        "--iteration <id>",
        "Iteration ID (from `eval iterations`)"
      )
      .requiredOption(
        "--project <id-or-name>",
        "Project the run belongs to (name or ID)"
      )
      .option(
        "--out <path>",
        "Save the PNG(s) to a file or directory instead of rendering inline"
      )
      .option("--index <n>", "Show only the Nth screenshot (1-based)")
  ).action(
    async (
      options: PlatformOptions & {
        project: string;
        run: string;
        iteration: string;
        out?: string;
        index?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const index =
        options.index !== undefined
          ? parsePositiveInteger(options.index, "--index")
          : undefined;

      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          getEvalIterationTraceOperation.execute(
            {
              project: options.project,
              runId: options.run,
              iterationId: options.iteration,
            },
            { client, signal }
          )
      );

      let shots = extractRenderedScreenshots(result);
      if (index !== undefined) {
        if (index > shots.length) {
          throw usageError(
            `--index ${index} is out of range; this iteration rendered ${shots.length} screenshot(s).`
          );
        }
        shots = [shots[index - 1]];
      }

      const base = {
        project: result.project,
        runId: result.runId,
        iterationId: result.iterationId,
      };
      const isJson = globalOptions.format === "json";

      // Save mode: download each PNG to disk regardless of output format.
      if (options.out !== undefined) {
        const saved: ScreenshotItem[] = [];
        for (let i = 0; i < shots.length; i += 1) {
          const shot = shots[i];
          const bytes = await fetchScreenshotBytes(
            shot.screenshotUrl,
            globalOptions.timeout
          );
          const path = resolveScreenshotPath(
            options.out,
            shot,
            i,
            shots.length
          );
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, bytes);
          saved.push({ ...shot, savedTo: path });
        }
        if (isJson) {
          writeResult({ ...base, items: saved });
          return;
        }
        if (saved.length === 0) {
          process.stdout.write(
            "No rendered widget screenshots for this iteration.\n"
          );
          return;
        }
        for (const shot of saved) {
          process.stdout.write(
            `Saved ${shot.toolName ?? "widget"} → ${shot.savedTo}\n`
          );
        }
        return;
      }

      // JSON without --out: structured screenshot URLs, no image bytes.
      if (isJson) {
        writeResult({ ...base, items: shots });
        return;
      }

      // Human: render inline if the terminal supports it, else print the URL.
      if (shots.length === 0) {
        process.stdout.write(
          "No rendered widget screenshots for this iteration.\n"
        );
        return;
      }
      const protocol = detectInlineImageProtocol();
      for (const shot of shots) {
        const caption = `${shot.toolName ?? "widget"} · ${shot.status}`;
        if (protocol) {
          const bytes = await fetchScreenshotBytes(
            shot.screenshotUrl,
            globalOptions.timeout
          );
          process.stdout.write(`${caption}\n`);
          process.stdout.write(encodeInlineImage(bytes, protocol));
        } else {
          process.stdout.write(`${caption}  ${shot.screenshotUrl}\n`);
        }
      }
    }
  );

  addPlatformOptions(
    evals
      .command("video")
      .description(
        "Get the Playwright replay video (.webm) an eval iteration recorded — prints the URL, or downloads it with --out"
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption(
        "--iteration <id>",
        "Iteration ID (from `eval iterations`)"
      )
      .requiredOption(
        "--project <id-or-name>",
        "Project the run belongs to (name or ID)"
      )
      .option("--out <path>", "Download the .webm to this file instead of printing the URL")
  ).action(
    async (
      options: PlatformOptions & {
        project: string;
        run: string;
        iteration: string;
        out?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          getEvalIterationTraceOperation.execute(
            {
              project: options.project,
              runId: options.run,
              iterationId: options.iteration,
            },
            { client, signal }
          )
      );

      const videoUrl = extractIterationVideoUrl(result);
      const base = {
        project: result.project,
        runId: result.runId,
        iterationId: result.iterationId,
      };
      const isJson = globalOptions.format === "json";

      if (!videoUrl) {
        if (isJson) {
          writeResult({ ...base, videoUrl: null });
          return;
        }
        process.stdout.write("No replay video for this iteration.\n");
        return;
      }

      if (options.out !== undefined) {
        const bytes = await fetchArtifactBytes(
          videoUrl,
          globalOptions.timeout,
          "video"
        );
        mkdirSync(dirname(options.out), { recursive: true });
        writeFileSync(options.out, bytes);
        if (isJson) {
          writeResult({ ...base, videoUrl, savedTo: options.out });
          return;
        }
        process.stdout.write(`Saved replay video → ${options.out}\n`);
        return;
      }

      if (isJson) {
        writeResult({ ...base, videoUrl });
        return;
      }
      process.stdout.write(`${videoUrl}\n`);
    }
  );

  // ── Suite settings: get / update / delete / schedule ───────────────
  addPlatformOptions(
    evals
      .command("get")
      .description("Show an eval suite's full settings")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
  ).action(
    async (
      options: PlatformOptions & { project?: string; suite: string },
      command
    ) => {
      await executeOp(
        getEvalSuiteOperation,
        { project: options.project, suite: options.suite },
        options,
        command
      );
    }
  );

  addPlatformOptions(
    evals
      .command("update")
      .description(
        "Edit an eval suite's settings (only the flags you pass change)"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--file <path>", "Suite-update JSON body (or - for stdin)")
      .option("--json <json>", "Inline suite-update JSON (or @file, or -)")
      .option("--name <name>", "Rename the suite")
      .option("--description <text>", "Suite description")
      .option(
        "--server <name...>",
        "Replace the suite's server selection (project server names)"
      )
      .option("--host <name...>", "Replace host attachments (by name/ID)")
      .option("--model <id>", "Execution model id")
      .option("--system-prompt <text>", "Execution system prompt")
      .option("--temperature <n>", "Execution temperature")
      .option("--min-accuracy <pct>", "Minimum accuracy, 0–100")
      .option("--tool-call-order <any|in-order|exact>", "Tool call order")
      .option("--arguments <ignore|partial|exact>", "Argument matching")
      .option("--extra-tool-calls <unlimited|N>", "Allowed extra tool calls")
      .option("--judge <on|off>", "Enable/disable LLM-as-judge grading")
      .option("--judge-model <id>", "Judge model id")
  ).action(async (options: PlatformOptions & Record<string, any>, command) => {
    const input = validateOpInput(
      updateEvalSuiteOperation,
      buildSuiteUpdateInput(options)
    );
    await executeOp(updateEvalSuiteOperation, input, options, command);
  });

  addPlatformOptions(
    evals
      .command("delete")
      .description("Permanently delete an eval suite (and its cases and runs)")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
  ).action(
    async (
      options: PlatformOptions & { project?: string; suite: string },
      command
    ) => {
      await executeOp(
        deleteEvalSuiteOperation,
        { project: options.project, suite: options.suite },
        options,
        command
      );
    }
  );

  addPlatformOptions(
    evals
      .command("schedule")
      .description("Enable or disable scheduled runs for a suite")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--enable", "Enable scheduled runs")
      .option("--disable", "Disable scheduled runs")
      .option("--interval <minutes>", "Run interval in minutes (5–10080)")
      .option(
        "--environment <id-or-name>",
        "Project environment the scheduled runs launch (only with --enable)"
      )
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        enable?: boolean;
        disable?: boolean;
        interval?: string;
        environment?: string;
      },
      command
    ) => {
      if (options.enable && options.disable) {
        throw usageError("Pass either --enable or --disable, not both.");
      }
      if (!options.enable && !options.disable) {
        throw usageError("Pass --enable or --disable.");
      }
      const input = validateOpInput(setEvalSuiteScheduleOperation, {
        project: options.project,
        suite: options.suite,
        enabled: Boolean(options.enable),
        ...(options.interval !== undefined
          ? { intervalMinutes: Number(options.interval) }
          : {}),
        ...(options.environment ? { environment: options.environment } : {}),
      });
      await executeOp(setEvalSuiteScheduleOperation, input, options, command);
    }
  );

  // ── Suite environment attachments ──────────────────────────────────
  const environments = evals
    .command("environments")
    .description(
      "Attach or detach the project environments an eval suite runs against"
    );

  addPlatformOptions(
    environments
      .command("set")
      .description(
        "Replace the suite's attached environments (this sets the whole list)"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .requiredOption(
        "--environment <id-or-name...>",
        "Project environments to attach, in order"
      )
      .option("--project <id-or-name>", PROJECT_OPT)
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        environment: string[];
      },
      command
    ) => {
      await executeOp(
        setEvalSuiteEnvironmentsOperation,
        {
          project: options.project,
          suite: options.suite,
          environments: options.environment,
        },
        options,
        command
      );
    }
  );

  addPlatformOptions(
    environments
      .command("clear")
      .description(
        "Detach every environment, reverting the suite to its saved server selection"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
  ).action(
    async (
      options: PlatformOptions & { project?: string; suite: string },
      command
    ) => {
      await executeOp(
        setEvalSuiteEnvironmentsOperation,
        {
          project: options.project,
          suite: options.suite,
          environments: null,
        },
        options,
        command
      );
    }
  );

  // ── Case CRUD + generate ───────────────────────────────────────────
  const cases = evals
    .command("cases")
    .description("List, author, and edit an eval suite's test cases");

  addPlatformOptions(
    cases
      .command("list")
      .description("List a suite's test cases")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
  ).action(
    async (
      options: PlatformOptions & { project?: string; suite: string },
      command
    ) => {
      await executeOp(
        listEvalCasesOperation,
        { project: options.project, suite: options.suite },
        options,
        command
      );
    }
  );

  addPlatformOptions(
    cases
      .command("get")
      .description("Show one test case")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .requiredOption("--case <id-or-title>", "Eval case title or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        case: string;
      },
      command
    ) => {
      await executeOp(
        getEvalCaseOperation,
        { project: options.project, suite: options.suite, case: options.case },
        options,
        command
      );
    }
  );

  addPlatformOptions(
    cases
      .command("run")
      .description(
        "Run a single case as a persisted, fully-queryable run (inspect it with `eval iterations` / `eval steps` like any run)"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .requiredOption("--case <id-or-title>", "Eval case title or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option(
        "--server <id-or-name...>",
        "Override the suite's saved servers for this run"
      )
      .option(
        "--environment <id-or-name>",
        "Project environment to run against (must be attached to the suite)"
      )
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        case: string;
        server?: string[];
        environment?: string;
      },
      command
    ) => {
      await executeOp(
        runEvalCaseOperation,
        {
          project: options.project,
          suite: options.suite,
          case: options.case,
          ...(options.server?.length ? { servers: options.server } : {}),
          ...(options.environment ? { environment: options.environment } : {}),
        },
        options,
        command
      );
    }
  );

  addPlatformOptions(
    cases
      .command("create")
      .description("Add a test case to a suite (definition via --file/--json)")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--file <path>", "Case JSON body (or - for stdin)")
      .option("--json <json>", "Inline case JSON (or @file, or -)")
      .option("--title <title>", "Case title (overrides the body)")
  ).action(async (options: PlatformOptions & Record<string, any>, command) => {
    const input = validateOpInput(
      createEvalCaseOperation,
      buildCaseInput(options, { requireCase: false })
    );
    await executeOp(createEvalCaseOperation, input, options, command);
  });

  addPlatformOptions(
    cases
      .command("update")
      .description("Edit a test case (definition via --file/--json)")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .requiredOption("--case <id-or-title>", "Eval case title or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--file <path>", "Case JSON body (or - for stdin)")
      .option("--json <json>", "Inline case JSON (or @file, or -)")
      .option("--title <title>", "Rename the case")
  ).action(async (options: PlatformOptions & Record<string, any>, command) => {
    const input = validateOpInput(
      updateEvalCaseOperation,
      buildCaseInput(options, { requireCase: true })
    );
    await executeOp(updateEvalCaseOperation, input, options, command);
  });

  addPlatformOptions(
    cases
      .command("delete")
      .description("Permanently delete a test case")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .requiredOption("--case <id-or-title>", "Eval case title or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        case: string;
      },
      command
    ) => {
      await executeOp(
        deleteEvalCaseOperation,
        { project: options.project, suite: options.suite, case: options.case },
        options,
        command
      );
    }
  );

  addPlatformOptions(
    cases
      .command("generate")
      .description(
        "AI-generate test cases from the suite's tools (spends credits)"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--mode <normal|negative>", "Generation mode (default normal)")
      .option(
        "--server <id-or-name...>",
        "Servers to discover tools from (default: suite's)"
      )
      .option(
        "--environment <id-or-name>",
        "Discover tools from this attached environment's server set"
      )
      .option(
        "--case-model <id...>",
        "Execution model(s) for the generated cases"
      )
      .option("--simple <n>", "How many easy, single-tool cases")
      .option("--multi-tool <n>", "How many medium, 2+ tool cases")
      .option("--multi-turn <n>", "How many multi-turn follow-up cases")
      .option("--complex <n>", "How many hard / cross-server cases")
      .option("--negative <n>", "How many negative (no-tool) cases")
      .option(
        "--vary-user-styles",
        "Vary query phrasing across a realistic range of user styles"
      )
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        mode?: string;
        server?: string[];
        environment?: string;
        caseModel?: string[];
        simple?: string;
        multiTool?: string;
        multiTurn?: string;
        complex?: string;
        negative?: string;
        varyUserStyles?: boolean;
      },
      command
    ) => {
      const caseMix: Record<string, number> = {};
      for (const key of [
        "simple",
        "multiTool",
        "multiTurn",
        "complex",
        "negative",
      ] as const) {
        const raw = options[key];
        if (raw !== undefined) {
          // Number() (not parseInt) so partial junk like "2abc" is rejected
          // rather than silently truncated to 2.
          const parsed = Number(raw);
          if (!Number.isInteger(parsed)) {
            const flag = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
            throw usageError(
              `--${flag} requires an integer value, got "${raw}".`
            );
          }
          caseMix[key] = parsed;
        }
      }
      const input = validateOpInput(generateEvalCasesOperation, {
        project: options.project,
        suite: options.suite,
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.server ? { servers: options.server } : {}),
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.caseModel
          ? { caseModels: options.caseModel.map((model) => ({ model })) }
          : {}),
        ...(Object.keys(caseMix).length > 0 ? { caseMix } : {}),
        ...(options.varyUserStyles ? { varyUserStyles: true } : {}),
      });
      await executeOp(generateEvalCasesOperation, input, options, command);
    }
  );
}
