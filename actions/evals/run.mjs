import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SUMMARY_LIMIT,
  accessHeadersFromEnv,
  fetchRunBundle,
  publishPullRequestComment,
  readActionReceipts,
  renderReports,
  truncateMarkdown,
} from "./report.mjs";

const validId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
const escapeCommand = (value) =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

export function parseInputs(env) {
  const get = (name) => (env[`MCPJAM_ACTION_${name}`] ?? "").trim();
  const inputs = {
    apiKey: (env.MCPJAM_API_KEY ?? "").trim(),
    project: get("PROJECT"),
    suite: get("SUITE"),
    gate: get("GATE") || "false",
    minPassRate: get("MIN_PASS_RATE"),
    baselineRun: get("BASELINE_RUN"),
    baselineSha: get("BASELINE_SHA"),
    waitTimeout: get("WAIT_TIMEOUT"),
    cliVersion: get("CLI_VERSION") || "5.7.1",
    idempotencyKey: get("IDEMPOTENCY_KEY"),
    command: get("COMMAND"),
    comment: get("COMMENT") || "false",
  };
  for (const key of ["apiKey"]) {
    if (!inputs[key])
      throw new Error(
        `Missing required input: ${key === "apiKey" ? "api-key (add MCPJAM_API_KEY to GitHub Actions secrets)" : key}.`,
      );
  }
  if (!inputs.command && (!inputs.project || !inputs.suite))
    throw new Error("Provide project and suite, or provide command.");
  if (inputs.command && (inputs.project || inputs.suite))
    throw new Error("Use command or project/suite, not both.");
  if (!["true", "false"].includes(inputs.comment))
    throw new Error("comment must be true or false.");
  inputs.comment = inputs.comment === "true";
  if (!["true", "false"].includes(inputs.gate))
    throw new Error("gate must be true or false.");
  inputs.gate = inputs.gate === "true";
  if (
    !inputs.gate &&
    (inputs.minPassRate || inputs.baselineRun || inputs.baselineSha)
  ) {
    throw new Error("Gate settings require gate: true.");
  }
  if (
    inputs.command &&
    (inputs.gate ||
      inputs.minPassRate ||
      inputs.baselineRun ||
      inputs.baselineSha)
  ) {
    throw new Error("Gate settings are not supported with command.");
  }
  if (inputs.baselineRun && inputs.baselineSha)
    throw new Error("Use baseline-run or baseline-sha, not both.");
  if (inputs.baselineRun && !validId(inputs.baselineRun))
    throw new Error("baseline-run must be a run ID.");
  if (inputs.baselineSha && !/^[a-fA-F0-9]{7,64}$/.test(inputs.baselineSha))
    throw new Error("baseline-sha must be a commit SHA.");
  if (
    inputs.minPassRate &&
    (!/^\d+(?:\.\d+)?$/.test(inputs.minPassRate) ||
      Number(inputs.minPassRate) > 100)
  ) {
    throw new Error("min-pass-rate-percent must be between 0 and 100.");
  }
  if (
    inputs.waitTimeout &&
    (!/^\d+$/.test(inputs.waitTimeout) ||
      !Number.isSafeInteger(Number(inputs.waitTimeout)) ||
      Number(inputs.waitTimeout) <= 0)
  ) {
    throw new Error("wait-timeout-ms must be a positive safe integer.");
  }
  // No npm tags, URLs, paths or shell fragments in the package selector.
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(inputs.cliVersion))
    throw new Error("cli-version must be an exact version, such as 5.7.1.");
  if (inputs.idempotencyKey.length > 256)
    throw new Error("idempotency-key must be at most 256 characters.");
  if (!inputs.idempotencyKey && !inputs.command)
    inputs.idempotencyKey = deriveIdempotencyKey(env, inputs);
  return inputs;
}

/**
 * The ONE deployment this action talks to.
 *
 * The CLI reads `MCPJAM_API_URL` and the SDK reads `MCPJAM_BASE_URL`, so a
 * workflow that sets only one of them would otherwise point hosted mode and
 * command mode at different deployments. Both are collapsed to an origin here,
 * the command is given it as `MCPJAM_BASE_URL`, and a receipt naming any other
 * origin is refused rather than sent the API key.
 */
export function resolveConfiguredOrigin(env) {
  const configured = [
    ["MCPJAM_BASE_URL", env.MCPJAM_BASE_URL],
    ["MCPJAM_API_URL", env.MCPJAM_API_URL],
  ].flatMap(([name, value]) => {
    const raw = (value ?? "").trim();
    if (!raw) return [];
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${name} must be an absolute URL.`);
    }
    if (url.username || url.password)
      throw new Error(`${name} must not carry credentials.`);
    if (url.protocol !== "https:")
      throw new Error(`${name} must use HTTPS.`);
    return [url.origin];
  });
  if (configured.length === 0) return "https://app.mcpjam.com";
  if (new Set(configured).size > 1)
    throw new Error("MCPJAM_BASE_URL and MCPJAM_API_URL must use the same origin.");
  return configured[0];
}

export function deriveIdempotencyKey(env, inputs) {
  // run_attempt is deliberately excluded: a rerun must observe the paid run
  // already launched by this job, rather than purchase a duplicate.
  const identity = [
    env.GITHUB_SERVER_URL,
    env.GITHUB_REPOSITORY,
    env.GITHUB_WORKFLOW,
    env.GITHUB_RUN_ID,
    env.GITHUB_JOB,
    env.MCPJAM_ACTION_INVOCATION,
    env.MCPJAM_ACTION_MATRIX,
    inputs.project,
    inputs.suite,
  ];
  if (!env.GITHUB_RUN_ID || !env.GITHUB_JOB || !env.MCPJAM_ACTION_INVOCATION) {
    throw new Error("Cannot derive retry identity; provide idempotency-key.");
  }
  return `github-evals:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

// The CLI renderers redact reports. Also remove the supplied key literally,
// including its JSON/XML encodings, before any file is uploaded.
export function redactSecret(text, key) {
  if (!key) return text;
  const xml = key
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
  const forms = [...new Set([key, JSON.stringify(key).slice(1, -1), xml])].sort(
    (a, b) => b.length - a.length,
  );
  return forms.reduce(
    (value, form) => value.replaceAll(form, "[REDACTED]"),
    text,
  );
}

export function invokeCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        tooLarge = true;
        child.kill("SIGTERM");
      } else chunks.push(chunk);
    });
    child.on("error", () =>
      reject(new Error("Could not start the MCPJam CLI.")),
    );
    child.on("close", (code) => {
      if (tooLarge) reject(new Error("CLI receipt exceeded the size limit."));
      else
        resolve({
          code: code ?? 5,
          stdout: Buffer.concat(chunks).toString("utf8"),
        });
    });
  });
}

export function invokeCommand(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      env,
      shell: true,
      stdio: "inherit",
    });
    child.on("error", () => reject(new Error("Could not start the eval command.")));
    child.on("close", (code) => resolve({ code: code ?? 1 }));
  });
}

function parseReceipt(stdout) {
  let receipt;
  try {
    receipt = JSON.parse(stdout);
  } catch {
    throw new Error("CLI did not return a valid JSON receipt.");
  }
  const targets = receipt?.launch?.targets;
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    !Array.isArray(receipt.runs) ||
    !["started", "partial", "failed"].includes(receipt.launch.outcome) ||
    targets.some(
      (target) =>
        !["started", "failed"].includes(target.status) ||
        (target.status === "started" && !validId(target.runId)),
    ) ||
    receipt.runs.some((run) => !validId(run.id))
  ) {
    throw new Error("CLI receipt has an unsupported shape.");
  }
  const ids = targets
    .filter((target) => target.status === "started")
    .map((target) => target.runId);
  if (
    new Set(ids).size !== ids.length ||
    new Set(receipt.runs.map((run) => run.id)).size !== receipt.runs.length ||
    receipt.runs.some((run) => !ids.includes(run.id))
  )
    throw new Error("CLI receipt contains inconsistent run IDs.");
  return { receipt, ids };
}

function completeEvidence(report, receipt, ids) {
  const rows = report?.metadata?.runs;
  return (
    report?.schemaVersion === 1 &&
    report.kind === "eval-run" &&
    Array.isArray(report.cases) &&
    report.cases.every(
      (entry) =>
        typeof entry.passed === "boolean" &&
        !(["reporting", "launch"].includes(entry.category) && !entry.passed),
    ) &&
    ids.length > 0 &&
    receipt.launch.outcome === "started" &&
    receipt.launch.targets.every((target) => target.status === "started") &&
    receipt.runs.length === ids.length &&
    receipt.runs.every(
      (run) =>
        run.status === "completed" && ["passed", "failed"].includes(run.result),
    ) &&
    Array.isArray(rows) &&
    rows.length === ids.length &&
    new Set(rows.map((row) => row.id)).size === ids.length &&
    rows.every(
      (row) =>
        ids.includes(row.id) &&
        row.iterationsComplete === true &&
        row.status === "completed" &&
        row.result === receipt.runs.find((run) => run.id === row.id)?.result,
    )
  );
}

async function output(env, values, apiKey) {
  if (!env.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(values)) {
    const delimiter = `mcpjam_${randomUUID()}`;
    await appendFile(
      env.GITHUB_OUTPUT,
      `${key}<<${delimiter}\n${redactSecret(String(value), apiKey)}\n${delimiter}\n`,
    );
  }
}

// One run at a time, and a run that cannot be read costs only itself: a
// concurrent fetch that rejects discards every bundle already paid for and
// leaves the reader with no report at all.
async function loadRunBundles(receipts, apiKey, fetchImpl, log, env) {
  const accessHeaders = accessHeadersFromEnv(env);
  const bundles = [];
  const missing = [];
  for (const receipt of receipts) {
    try {
      bundles.push(
        await fetchRunBundle(receipt, apiKey, fetchImpl, accessHeaders),
      );
    } catch (error) {
      // Name the reason: an identity proxy in front of the deployment answers
      // every read the same way, and "could not load" alone sent readers
      // looking at the run instead of at the request.
      log(
        `::warning::Could not read MCPJam run ${receipt.runId}: ${redactSecret(error.message, apiKey)}`,
      );
      missing.push(receipt.runId);
    }
  }
  if (missing.length > 0)
    log(
      `::warning::Could not load MCPJam results for ${missing.join(", ")}. The summary covers the runs that loaded.`,
    );
  return { bundles, missing };
}

async function publishDetailedReports({
  bundles,
  directory,
  jsonName,
  inputs,
  env,
  log,
  fetchImpl,
  outcome,
}) {
  const reports = renderReports(bundles, outcome);
  await writeFile(join(directory, "eval-report.md"), `${reports.summary}\n`);
  await writeFile(
    join(directory, jsonName),
    JSON.stringify({ schemaVersion: 1, runs: bundles }, null, 2),
  );
  if (inputs.comment && env.MCPJAM_ACTION_PULL_REQUEST) {
    try {
      const published = await publishPullRequestComment(
        reports.comment,
        env,
        fetchImpl,
      );
      log(`MCPJam PR comment ${published}.`);
    } catch {
      log(
        "::warning::Could not publish the MCPJam PR comment. Check pull-requests: write permission.",
      );
    }
  }
  return reports.summary;
}

export async function runAction(
  env = process.env,
  invoke = invokeCli,
  log = (message) => process.stdout.write(`${message}\n`),
  execute = invokeCommand,
  fetchImpl = fetch,
) {
  const state = {
    result: "failed",
    runIds: [],
    runExitCode: "",
    gateExitCodes: {},
    message: "Evaluation did not complete.",
  };
  let renderedSummary = "";
  const key = (env.MCPJAM_API_KEY ?? "").trim();
  if (key) log(`::add-mask::${escapeCommand(key)}`);
  const githubToken = (env.MCPJAM_ACTION_GITHUB_TOKEN ?? "").trim();
  if (githubToken) log(`::add-mask::${escapeCommand(githubToken)}`);
  // The identity-proxy service token, when one is configured, is a credential
  // like the others and never belongs in a log line. Both halves: Cloudflare
  // issues and revokes the id and the secret as one pair.
  for (const name of ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"]) {
    const value = (env[name] ?? "").trim();
    if (value) log(`::add-mask::${escapeCommand(value)}`);
  }
  let directory;
  try {
    const inputs = parseInputs(env);
    const origin = resolveConfiguredOrigin(env);
    directory = await mkdtemp(
      join(env.RUNNER_TEMP || tmpdir(), "mcpjam-evals-"),
    );
    if (inputs.command) {
      // The action's own token is never handed to the user's command: the
      // command needs the MCPJam key and its receipt directory, nothing else.
      const { MCPJAM_ACTION_GITHUB_TOKEN: _token, ...commandEnv } = env;
      const command = await execute(inputs.command, {
        ...commandEnv,
        MCPJAM_API_KEY: inputs.apiKey,
        MCPJAM_BASE_URL: origin,
        MCPJAM_ACTION_RECEIPT_DIR: directory,
      });
      state.runExitCode = command.code;
      const receipts = await readActionReceipts(directory, origin);
      if (receipts.length === 0) {
        // Every cause but one leaves the same empty directory, so name the
        // condition rather than blaming a version: a command that never got
        // that far, and reporting that failed non-strictly (an expired key, an
        // unreachable API) both land here having exited normally.
        state.message =
          command.code === 0
            ? `The eval command exited 0 but reported no MCPJam run to ${origin}. Check its output for an API key or connectivity failure, and that it reports results with @mcpjam/sdk.`
            : `The eval command exited ${command.code} without reporting a MCPJam run.`;
        throw new Error(state.message);
      }
      state.runIds = receipts.map((receipt) => receipt.runId);
      const { bundles, missing } = await loadRunBundles(
        receipts,
        inputs.apiKey,
        fetchImpl,
        log,
        env,
      );
      if (bundles.length === 0) {
        state.message = "Could not load any uploaded MCPJam run.";
        throw new Error(state.message);
      }
      const unresolved = bundles.filter(
        (bundle) => bundle.run.result !== "passed",
      );
      const result =
        command.code === 0 && unresolved.length === 0 && missing.length === 0
          ? "passed"
          : "failed";
      // Name what actually happened. An inconclusive run is not a failed one,
      // and a summary that says it is contradicts the report beside it.
      const outcome = {
        result,
        message:
          result === "passed"
            ? "All eval runs passed."
            : command.code !== 0
              ? `The eval command exited ${command.code}.`
              : unresolved.length > 0
                ? `Not every eval run passed: ${unresolved.map((bundle) => `${bundle.receipt.runId} is ${bundle.run.result}`).join(", ")}.`
                : `Could not load every uploaded eval run: ${missing.join(", ")}.`,
      };
      renderedSummary = await publishDetailedReports({
        bundles,
        directory,
        jsonName: "eval-report.json",
        inputs,
        env,
        log,
        fetchImpl,
        outcome,
      });
      // Adopted only once the reports the verdict points at actually exist.
      state.result = outcome.result;
      state.message = outcome.message;
    } else {
      const prefix = [
        "--yes",
        `@mcpjam/cli@${inputs.cliVersion}`,
        "cloud",
        "eval",
      ];
      const reportPath = join(directory, "eval-report.json");
      const args = [
        ...prefix,
        "run",
        `--project=${inputs.project}`,
        `--suite=${inputs.suite}`,
        "--wait",
        `--out=${reportPath}`,
        "--format=json",
        `--idempotency-key=${inputs.idempotencyKey}`,
      ];
      if (inputs.waitTimeout) args.push(`--wait-timeout=${inputs.waitTimeout}`);
      const cliEnv = { ...env, MCPJAM_API_KEY: inputs.apiKey };
      const run = await invoke(args, cliEnv);
      state.runExitCode = run.code;
      const { receipt, ids } = parseReceipt(run.stdout);
      state.runIds = ids;
      let report;
      try {
        report = JSON.parse(await readFile(reportPath, "utf8"));
      } catch {
        /* Missing evidence cannot pass. */
      }
      let safeToPass =
        [0, 1].includes(run.code) && completeEvidence(report, receipt, ids);
      if (inputs.gate) {
        for (const [index, row] of receipt.runs.entries()) {
          if (row.status !== "completed") continue;
          const gatePath = join(directory, `gate-${index + 1}.xml`);
          const gateArgs = [
            ...prefix,
            "gate",
            `--project=${receipt.launch.project?.id || inputs.project}`,
            `--run=${row.id}`,
            "--wait",
            "--reporter=junit-xml",
            `--out=${gatePath}`,
          ];
          if (inputs.minPassRate)
            gateArgs.push(`--min-pass-rate-percent=${inputs.minPassRate}`);
          if (inputs.baselineRun)
            gateArgs.push(`--baseline=${inputs.baselineRun}`);
          if (inputs.baselineSha)
            gateArgs.push(`--baseline-sha=${inputs.baselineSha}`);
          if (inputs.waitTimeout)
            gateArgs.push(`--wait-timeout=${inputs.waitTimeout}`);
          let gate;
          try {
            gate = await invoke(gateArgs, cliEnv);
          } catch {
            state.gateExitCodes[row.id] = 3;
            safeToPass = false;
            continue;
          }
          state.gateExitCodes[row.id] = gate.code;
          let xml = "";
          try {
            xml = await readFile(gatePath, "utf8");
          } catch {
            /* A missing gate report fails the action. */
          }
          safeToPass &&=
            gate.code === 0 &&
            xml.includes("<testsuites ") &&
            xml.includes("</testsuites>");
        }
        safeToPass &&= Object.keys(state.gateExitCodes).length === ids.length;
      } else {
        safeToPass &&=
          run.code === 0 && receipt.runs.every((row) => row.result === "passed");
      }
      state.result = safeToPass ? "passed" : "failed";
      state.message = safeToPass
        ? inputs.gate
          ? "All gates passed or were waived."
          : "All eval runs passed."
        : "Eval, gate, or reporting failed or was incomplete. See the reports and exit codes.";
      const projectId = receipt.launch.project?.id;
      const suiteId = receipt.launch.suite?.id;
      if (ids.length > 0 && validId(projectId) && validId(suiteId)) {
        const detailReceipts = ids.map((runId) => ({
          schemaVersion: 1,
          baseUrl: origin,
          projectId,
          suiteId,
          suiteName: receipt.launch.suite.name || inputs.suite,
          runId,
        }));
        try {
          const { bundles } = await loadRunBundles(
            detailReceipts,
            inputs.apiKey,
            fetchImpl,
            log,
            env,
          );
          if (bundles.length > 0)
            renderedSummary = await publishDetailedReports({
              bundles,
              directory,
              jsonName: "eval-details.json",
              inputs,
              env,
              log,
              fetchImpl,
              outcome: state,
            });
        } catch {
          log("::warning::Could not load detailed MCPJam results for the summary.");
        }
      }
    }
  } catch (error) {
    // Only validation errors are echoed; unexpected filesystem/process errors
    // can contain credentials or other data from the environment.
    state.message = directory
      ? state.message === "Evaluation did not complete."
        ? "Could not finish the eval action. Check the reports and CLI exit code."
        : state.message
      : redactSecret(error.message, key);
  }
  if (directory) {
    try {
      // Only known, renderer-produced report files are uploaded. Raw stdout
      // receipts and stderr are deliberately kept out of artifacts and logs.
      for (const file of await readdir(directory)) {
        const path = join(directory, file);
        await writeFile(path, redactSecret(await readFile(path, "utf8"), key));
      }
      await writeFile(
        join(directory, "action-result.json"),
        redactSecret(JSON.stringify(state, null, 2), key),
      );
    } catch {
      // Do not upload any directory whose final redaction could not finish.
      directory = undefined;
      state.result = "failed";
      state.message = "Could not safely write the eval reports.";
    }
  }
  if (env.GITHUB_STEP_SUMMARY) {
    // The verdict block is never replaced by the rendered report: it carries
    // the action's own result, the exit codes and the run ids, and GitHub
    // discards an oversized summary whole rather than trimming it.
    const verdict = redactSecret(
      `### MCPJam evals: ${state.result}\n\n${state.message}\n\nRun exit code: ${state.runExitCode === "" ? "not started" : state.runExitCode}\n\nRuns: ${state.runIds.join(", ") || "none"}\n\nGate exit codes: ${JSON.stringify(state.gateExitCodes)}\n`,
      key,
    );
    const separator = "\n\n---\n\n";
    const safeSummary = redactSecret(renderedSummary, key);
    const detail = renderedSummary
      ? `${truncateMarkdown(
          safeSummary,
          SUMMARY_LIMIT -
            Buffer.byteLength(verdict, "utf8") -
            Buffer.byteLength(separator, "utf8"),
          "\n\n_Report truncated. See the uploaded reports and the MCPJam run._",
        )}${separator}`
      : "";
    await appendFile(env.GITHUB_STEP_SUMMARY, `${detail}${verdict}`);
  }
  await output(
    env,
    {
      "run-ids": JSON.stringify(state.runIds),
      "run-exit-code": state.runExitCode,
      "gate-exit-codes": JSON.stringify(state.gateExitCodes),
      "report-path": directory || "",
      "artifact-name": `mcpjam-evals-${randomUUID()}`,
      result: state.result,
    },
    key,
  );
  if (state.result !== "passed")
    log(`::error::${escapeCommand(state.message)}`);
  return state;
}

export function finalExitCode(env) {
  return env.MCPJAM_ACTION_RESULT === "passed" &&
    env.MCPJAM_ACTION_UPLOAD_OUTCOME === "success"
    ? 0
    : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === "finalize") {
    process.exitCode = finalExitCode(process.env);
    if (process.exitCode)
      process.stdout.write(
        "::error::MCPJam evals or report upload did not pass.\n",
      );
  } else {
    // The final composite step fails AFTER reports have been uploaded.
    await runAction();
  }
}
