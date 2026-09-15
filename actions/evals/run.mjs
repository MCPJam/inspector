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
  };
  for (const key of ["apiKey", "project", "suite"]) {
    if (!inputs[key])
      throw new Error(
        `Missing required input: ${key === "apiKey" ? "api-key (add MCPJAM_API_KEY to GitHub Actions secrets)" : key}.`,
      );
  }
  if (!["true", "false"].includes(inputs.gate))
    throw new Error("gate must be true or false.");
  inputs.gate = inputs.gate === "true";
  if (
    !inputs.gate &&
    (inputs.minPassRate || inputs.baselineRun || inputs.baselineSha)
  ) {
    throw new Error("Gate settings require gate: true.");
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
  if (!inputs.idempotencyKey)
    inputs.idempotencyKey = deriveIdempotencyKey(env, inputs);
  return inputs;
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

export async function runAction(
  env = process.env,
  invoke = invokeCli,
  log = (message) => process.stdout.write(`${message}\n`),
) {
  const state = {
    result: "failed",
    runIds: [],
    runExitCode: "",
    gateExitCodes: {},
    message: "Evaluation did not complete.",
  };
  const key = (env.MCPJAM_API_KEY ?? "").trim();
  if (key) log(`::add-mask::${escapeCommand(key)}`);
  let directory;
  try {
    const inputs = parseInputs(env);
    directory = await mkdtemp(
      join(env.RUNNER_TEMP || tmpdir(), "mcpjam-evals-"),
    );
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
  } catch (error) {
    // Only validation errors are echoed; unexpected filesystem/process errors
    // can contain credentials or other data from the environment.
    state.message = directory
      ? "Could not finish the eval action. Check the reports and CLI exit code."
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
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      redactSecret(
        `### MCPJam evals: ${state.result}\n\n${state.message}\n\nRun exit code: ${state.runExitCode === "" ? "not started" : state.runExitCode}\n\nRuns: ${state.runIds.join(", ") || "none"}\n\nGate exit codes: ${JSON.stringify(state.gateExitCodes)}\n`,
        key,
      ),
    );
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
