import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { test } from "node:test";
import {
  finalExitCode,
  invokeCli,
  parseInputs,
  redactSecret,
  runAction,
} from "./run.mjs";

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "eval-action-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    MCPJAM_API_KEY: "sk-test-secret",
    MCPJAM_ACTION_PROJECT: "Project",
    MCPJAM_ACTION_SUITE: "Suite",
    MCPJAM_ACTION_INVOCATION: "MCPJaminspectoractions-evals",
    MCPJAM_ACTION_MATRIX: '{"os":"ubuntu"}',
    GITHUB_RUN_ID: "123",
    GITHUB_JOB: "evals",
    GITHUB_REPOSITORY: "example/repo",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_TEMP: root,
    GITHUB_OUTPUT: join(root, "outputs"),
    GITHUB_STEP_SUMMARY: join(root, "summary"),
    ...overrides,
  };
  const calls = [];
  const logs = [];
  const rows = [{ id: "run1", status: "completed", result: "passed" }];
  const receipt = {
    launch: {
      project: { id: "project1" },
      outcome: "started",
      targets: [{ status: "started", runId: "run1" }],
    },
    runs: rows,
  };
  const report = {
    schemaVersion: 1,
    kind: "eval-run",
    cases: [],
    metadata: {
      runs: rows.map((row) => ({ ...row, iterationsComplete: true })),
    },
  };
  const behavior = {
    runCode: 0,
    receipt,
    report,
    gateCodes: {},
    gateXml: {},
    noGateReport: false,
  };
  const invoke = async (args, childEnv) => {
    calls.push({ args, env: childEnv });
    const path = args.find((arg) => arg.startsWith("--out=")).slice(6);
    if (args.includes("run")) {
      if (behavior.report)
        await writeFile(path, JSON.stringify(behavior.report));
      return {
        code: behavior.runCode,
        stdout: behavior.stdout ?? JSON.stringify(behavior.receipt),
      };
    }
    const id = args.find((arg) => arg.startsWith("--run=")).slice(6);
    if (!behavior.noGateReport)
      await writeFile(
        path,
        behavior.gateXml[id] ??
          '<testsuites name="eval-gate" tests="1" failures="0"></testsuites>',
      );
    return { code: behavior.gateCodes[id] ?? 0, stdout: "never logged" };
  };
  const run = () => runAction(env, invoke, (line) => logs.push(line));
  return { root, env, calls, logs, behavior, run };
}

test("runs a suite, retains CI metadata, publishes output IDs and a report directory", async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.result, "passed");
  assert.deepEqual(result.runIds, ["run1"]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].env.GITHUB_RUN_ATTEMPT, "1");
  assert.ok(f.calls[0].args.includes("@mcpjam/cli@5.7.1"));
  assert.ok(f.calls[0].args.includes("--wait"));
  assert.ok(!f.calls[0].args.some((arg) => arg.includes("wait-timeout")));
  assert.match(
    await readFile(f.env.GITHUB_OUTPUT, "utf8"),
    /run-ids<<.*\n\["run1"\]/,
  );
  assert.match(
    await readFile(f.env.GITHUB_STEP_SUMMARY, "utf8"),
    /Run exit code: 0/,
  );
});

for (const [name, overrides] of Object.entries({
  "missing key": { MCPJAM_API_KEY: "" },
  "missing project": { MCPJAM_ACTION_PROJECT: "" },
  "missing suite": { MCPJAM_ACTION_SUITE: "" },
  "bad boolean": { MCPJAM_ACTION_GATE: "yes" },
  "gate disabled": { MCPJAM_ACTION_MIN_PASS_RATE: "95" },
  "conflicting baselines": {
    MCPJAM_ACTION_GATE: "true",
    MCPJAM_ACTION_BASELINE_RUN: "base1",
    MCPJAM_ACTION_BASELINE_SHA: "abcdef1",
  },
  "bad threshold": {
    MCPJAM_ACTION_GATE: "true",
    MCPJAM_ACTION_MIN_PASS_RATE: "101",
  },
  "negative threshold": {
    MCPJAM_ACTION_GATE: "true",
    MCPJAM_ACTION_MIN_PASS_RATE: "-1",
  },
  "bad SHA": {
    MCPJAM_ACTION_GATE: "true",
    MCPJAM_ACTION_BASELINE_SHA: "not-a-sha",
  },
  "bad run ID": {
    MCPJAM_ACTION_GATE: "true",
    MCPJAM_ACTION_BASELINE_RUN: "../base",
  },
  "zero timeout": { MCPJAM_ACTION_WAIT_TIMEOUT: "0" },
  "fraction timeout": { MCPJAM_ACTION_WAIT_TIMEOUT: "1.5" },
  "version URL": { MCPJAM_ACTION_CLI_VERSION: "https://example.org/cli" },
  "version tag": { MCPJAM_ACTION_CLI_VERSION: "latest" },
  "long retry key": { MCPJAM_ACTION_IDEMPOTENCY_KEY: "x".repeat(257) },
  "missing retry identity": { GITHUB_RUN_ID: "" },
})) {
  test(`rejects ${name} before launching`, async (t) => {
    const f = await fixture(t, overrides);
    assert.equal((await f.run()).result, "failed");
    assert.equal(f.calls.length, 0);
  });
}

for (const code of [1, 2, 3, 4, 5, 127]) {
  test(`preserves run exit ${code} and fails without gates`, async (t) => {
    const f = await fixture(t);
    f.behavior.runCode = code;
    if (code === 1) {
      f.behavior.receipt.runs[0].result = "failed";
      f.behavior.report.metadata.runs[0].result = "failed";
    }
    const result = await f.run();
    assert.equal(result.result, "failed");
    assert.equal(result.runExitCode, code);
    assert.equal(f.calls.length, 1, "never automatically retries");
  });
}

for (const scenario of ["waiver", "lower threshold"]) {
  test(`${scenario} can pass a failed eval through the gate`, async (t) => {
    const f = await fixture(t, {
      MCPJAM_ACTION_GATE: "true",
      MCPJAM_ACTION_MIN_PASS_RATE: "95",
    });
    f.behavior.runCode = 1;
    f.behavior.receipt.runs[0].result = "failed";
    f.behavior.report.metadata.runs[0].result = "failed";
    f.behavior.report.cases = [{ category: "eval", passed: false }];
    if (scenario === "waiver")
      f.behavior.gateXml.run1 =
        '<testsuites name="gate" skipped="1"><testcase><skipped message="Gate WAIVED"/></testcase></testsuites>';
    const result = await f.run();
    assert.equal(result.result, "passed");
    assert.equal(result.runExitCode, 1);
    assert.deepEqual(result.gateExitCodes, { run1: 0 });
    assert.ok(f.calls[1].args.includes("--min-pass-rate-percent=95"));
    assert.ok(!f.calls[1].args.includes("--no-suite-policy"));
  });
}

for (const [name, code] of [
  ["expired waiver", 1],
  ["suite policy failure despite waiver", 1],
  ["missing baseline", 3],
  ["unknown scorer", 2],
]) {
  test(`gate ${name} remains blocking`, async (t) => {
    const f = await fixture(t, { MCPJAM_ACTION_GATE: "true" });
    f.behavior.gateCodes.run1 = code;
    const result = await f.run();
    assert.equal(result.result, "failed");
    assert.equal(result.gateExitCodes.run1, code);
  });
}

test("gates all completed runs and requires every gate to pass", async (t) => {
  const f = await fixture(t, { MCPJAM_ACTION_GATE: "true" });
  f.behavior.receipt.launch.targets.push({ status: "started", runId: "run2" });
  f.behavior.receipt.runs.push({
    id: "run2",
    status: "completed",
    result: "passed",
  });
  f.behavior.report.metadata.runs.push({
    id: "run2",
    status: "completed",
    result: "passed",
    iterationsComplete: true,
  });
  f.behavior.gateCodes.run1 = 1;
  assert.equal((await f.run()).result, "failed");
  assert.equal(f.calls.length, 3);
});

test("multiple completed runs can all pass and receive separate gate reports", async (t) => {
  const f = await fixture(t, {
    MCPJAM_ACTION_GATE: "true",
    MCPJAM_ACTION_BASELINE_RUN: "base1",
  });
  f.behavior.receipt.launch.targets.push({ status: "started", runId: "run2" });
  f.behavior.receipt.runs.push({
    id: "run2",
    status: "completed",
    result: "passed",
  });
  f.behavior.report.metadata.runs.push({
    id: "run2",
    status: "completed",
    result: "passed",
    iterationsComplete: true,
  });
  assert.equal((await f.run()).result, "passed");
  assert.ok(f.calls[1].args.includes("--baseline=base1"));
  const paths = f.calls
    .slice(1)
    .map((call) => call.args.find((arg) => arg.startsWith("--out=")));
  assert.equal(new Set(paths).size, 2);
});

test("a gate process failure does not prevent checking the next run", async (t) => {
  const f = await fixture(t, { MCPJAM_ACTION_GATE: "true" });
  f.behavior.receipt.launch.targets.push({ status: "started", runId: "run2" });
  f.behavior.receipt.runs.push({
    id: "run2",
    status: "completed",
    result: "passed",
  });
  const gated = [];
  const result = await runAction(
    f.env,
    async (args) => {
      if (args.includes("run"))
        return { code: 0, stdout: JSON.stringify(f.behavior.receipt) };
      gated.push(args.find((arg) => arg.startsWith("--run=")));
      throw new Error("process failed");
    },
    () => {},
  );
  assert.equal(result.result, "failed");
  assert.deepEqual(gated, ["--run=run1", "--run=run2"]);
  assert.deepEqual(result.gateExitCodes, { run1: 3, run2: 3 });
});

test("report sanitization failure suppresses the upload directory", async (t) => {
  const f = await fixture(t);
  const result = await runAction(
    f.env,
    async (args) => {
      const path = args.find((arg) => arg.startsWith("--out=")).slice(6);
      await mkdir(path);
      return { code: 0, stdout: JSON.stringify(f.behavior.receipt) };
    },
    () => {},
  );
  assert.equal(result.result, "failed");
  assert.match(
    await readFile(f.env.GITHUB_OUTPUT, "utf8"),
    /report-path<<[^\n]+\n\n/,
  );
});

for (const [name, mutate] of [
  [
    "partial launch hidden by verdict exit 1",
    (b) => {
      b.runCode = 1;
      b.receipt.launch.outcome = "partial";
      b.receipt.launch.targets.push({ status: "failed" });
    },
  ],
  [
    "timeout",
    (b) => {
      b.runCode = 5;
      b.receipt.runs = [];
    },
  ],
  [
    "inconclusive result",
    (b) => {
      b.receipt.runs[0].result = "inconclusive";
    },
  ],
  [
    "failed execution",
    (b) => {
      b.receipt.runs[0].status = "failed";
    },
  ],
  [
    "grading",
    (b) => {
      b.receipt.runs[0].status = "grading";
    },
  ],
  [
    "missing JSON report",
    (b) => {
      b.report = null;
    },
  ],
  [
    "malformed report",
    (b) => {
      b.report = {};
    },
  ],
  [
    "reporting failure hidden by verdict exit 1",
    (b) => {
      b.runCode = 1;
      b.report.cases.push({ category: "reporting", passed: false });
    },
  ],
  [
    "partial iteration fetch",
    (b) => {
      b.report.metadata.runs[0].iterationsComplete = false;
    },
  ],
  [
    "missing target completion",
    (b) => {
      b.receipt.launch.targets.push({ status: "started", runId: "run2" });
    },
  ],
  [
    "duplicate report rows",
    (b) => {
      b.report.metadata.runs.push(b.report.metadata.runs[0]);
    },
  ],
  [
    "missing gate report",
    (b) => {
      b.noGateReport = true;
    },
  ],
  [
    "malformed gate report",
    (b) => {
      b.gateXml.run1 = "not XML";
    },
  ],
  [
    "invalid JSON receipt",
    (b) => {
      b.stdout = "not JSON";
    },
  ],
  [
    "unexpected receipt",
    (b) => {
      b.stdout = "{}";
    },
  ],
  [
    "unknown completed run",
    (b) => {
      b.receipt.runs[0].id = "unrelated";
    },
  ],
  [
    "duplicate target",
    (b) => {
      b.receipt.launch.targets.push(b.receipt.launch.targets[0]);
    },
  ],
]) {
  test(`gate success cannot hide ${name}`, async (t) => {
    const f = await fixture(t, { MCPJAM_ACTION_GATE: "true" });
    mutate(f.behavior);
    assert.equal((await f.run()).result, "failed");
  });
}

test("run IDs survive timeout and are not replaced by an empty completion list", async (t) => {
  const f = await fixture(t);
  f.behavior.runCode = 5;
  f.behavior.receipt.runs = [];
  assert.deepEqual((await f.run()).runIds, ["run1"]);
});

test("passes baseline and explicit wait settings literally, including zero threshold", async (t) => {
  const f = await fixture(t, {
    MCPJAM_ACTION_GATE: "true",
    MCPJAM_ACTION_MIN_PASS_RATE: "0",
    MCPJAM_ACTION_BASELINE_SHA: "abcdef123",
    MCPJAM_ACTION_WAIT_TIMEOUT: "42000",
  });
  await f.run();
  assert.ok(f.calls[0].args.includes("--wait-timeout=42000"));
  assert.ok(f.calls[1].args.includes("--wait-timeout=42000"));
  assert.ok(f.calls[1].args.includes("--baseline-sha=abcdef123"));
  assert.ok(f.calls[1].args.includes("--min-pass-rate-percent=0"));
});

test("retry identity is stable across attempts and distinct across jobs, matrices and invocations", async (t) => {
  const f = await fixture(t);
  const key = parseInputs(f.env).idempotencyKey;
  assert.equal(
    parseInputs({ ...f.env, GITHUB_RUN_ATTEMPT: "2" }).idempotencyKey,
    key,
  );
  for (const field of [
    "GITHUB_RUN_ID",
    "GITHUB_JOB",
    "GITHUB_REPOSITORY",
    "MCPJAM_ACTION_MATRIX",
    "MCPJAM_ACTION_INVOCATION",
    "MCPJAM_ACTION_SUITE",
  ]) {
    assert.notEqual(
      parseInputs({ ...f.env, [field]: "different" }).idempotencyKey,
      key,
      field,
    );
  }
  assert.equal(
    parseInputs({ ...f.env, MCPJAM_ACTION_IDEMPOTENCY_KEY: "custom" })
      .idempotencyKey,
    "custom",
  );
});

test("artifacts and logs never include the key or raw CLI output", async (t) => {
  const f = await fixture(t, { MCPJAM_ACTION_GATE: "true" });
  f.behavior.report.secret = f.env.MCPJAM_API_KEY;
  f.behavior.gateXml.run1 = `<testsuites name="gate"><system-out>${f.env.MCPJAM_API_KEY}</system-out></testsuites>`;
  await f.run();
  const dir = (await readdir(f.root)).find((name) =>
    name.startsWith("mcpjam-evals-"),
  );
  for (const file of await readdir(join(f.root, dir))) {
    assert.ok(
      !(await readFile(join(f.root, dir, file), "utf8")).includes(
        f.env.MCPJAM_API_KEY,
      ),
    );
  }
  assert.ok(
    !f.logs
      .filter((line) => !line.startsWith("::add-mask::"))
      .join("\n")
      .includes(f.env.MCPJAM_API_KEY),
  );
  assert.ok(!f.logs.join("\n").includes("never logged"));
  assert.ok(
    !f.calls
      .flatMap((call) => call.args)
      .join("\n")
      .includes(f.env.MCPJAM_API_KEY),
  );
  assert.equal(redactSecret("a&lt;&amp;&quot;", '<&"'), "a[REDACTED]");
});

test("process invocation preserves special characters and never executes a shell", async (t) => {
  const f = await fixture(t, {
    MCPJAM_ACTION_PROJECT: "--version",
    MCPJAM_ACTION_SUITE: 'Suite " $(touch unsafe) `id`\nsecond line',
  });
  await f.run();
  assert.ok(f.calls[0].args.includes(`--suite=${f.env.MCPJAM_ACTION_SUITE}`));
  assert.ok(f.calls[0].args.includes("--project=--version"));
  const executable = join(f.root, "npx");
  await writeFile(
    executable,
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
  );
  await chmod(executable, 0o755);
  const args = ["$(touch unsafe)", "with spaces", "`id`", "line\nbreak"];
  const result = await invokeCli(args, {
    ...process.env,
    PATH: `${f.root}${delimiter}${process.env.PATH}`,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("process failure and unsafe report write cannot produce success", async (t) => {
  const f = await fixture(t);
  const result = await runAction(
    f.env,
    async () => {
      throw new Error(f.env.MCPJAM_API_KEY);
    },
    () => {},
  );
  assert.equal(result.result, "failed");
  assert.ok(!result.message.includes(f.env.MCPJAM_API_KEY));
  const broken = await fixture(t);
  await runAction(
    broken.env,
    async (args) => {
      const out = args.find((arg) => arg.startsWith("--out=")).slice(6);
      await writeFile(out, Buffer.from([0xff]));
      return { code: 0, stdout: JSON.stringify(broken.behavior.receipt) };
    },
    () => {},
  ).then((state) => assert.equal(state.result, "failed"));
});

test("final step only passes after both evaluation and upload succeed", () => {
  for (const result of ["passed", "failed", "", undefined]) {
    for (const upload of [
      "success",
      "failure",
      "skipped",
      "cancelled",
      undefined,
    ]) {
      assert.equal(
        finalExitCode({
          MCPJAM_ACTION_RESULT: result,
          MCPJAM_ACTION_UPLOAD_OUTCOME: upload,
        }),
        result === "passed" && upload === "success" ? 0 : 1,
      );
    }
  }
});
