/**
 * `eval validate` and `eval export` — the two disk-facing halves of the suite
 * file.
 *
 * What is worth asserting here, over and above "the command ran":
 *
 *  - `eval validate` reaches NO network and needs NO key. It is driven below
 *    with no `--api-key`, no `--api-url` and no fixture server at all, so a
 *    client construction sneaking into it would fail the test rather than
 *    quietly work on the author's machine.
 *  - The three exit codes mean three different things, and the difference
 *    between 1 and 2 is the whole point: 1 is a verdict on the file, 2 means
 *    no verdict was reached.
 *  - `eval export` writes NOTHING when it cannot represent a suite. The
 *    assertion is on the DIRECTORY being empty, not on the command failing —
 *    a partial file plus a non-zero exit would pass the weaker check.
 *  - A repeated export of the same legacy case produces the same case id. A
 *    minted id would pass every other test in this file and fork the case's
 *    history on the second run.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import test, { describe } from "node:test";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalSuiteFile } from "@mcpjam/sdk";
import {
  modalRepetitions,
  percentToFraction,
} from "../src/lib/eval-suite-export.js";
import { main } from "../src/index.js";

const telemetryDisabled = {
  env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: "1" },
};

/**
 * The two helpers below mutate PROCESS-GLOBAL state — `captureProcessOutput`
 * replaces `process.stdout.write`/`process.stderr.write`, and `withTempDir`
 * calls `process.chdir` (which `eval export`'s default path resolution needs).
 * Both restore in `finally`, which is correct only while the tests in this file
 * run one at a time. `node:test` runs subtests within a file sequentially by
 * default; do NOT enable concurrency here, or one test will capture another's
 * output and read another's working directory.
 */

async function captureProcessOutput<T>(fn: () => Promise<T>): Promise<{
  result: T;
  stdout: string;
  stderr: string;
}> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";

  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      stdout += chunk;
      return true;
    }
    return (originalStdoutWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest
    );
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      stderr += chunk;
      return true;
    }
    return (originalStderrWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest
    );
  }) as typeof process.stderr.write;

  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  // `realpath`, because the commands under test resolve their output paths
  // against `process.cwd()`. On macOS `os.tmpdir()` is `/var/folders/...`, a
  // symlink to `/private/var/folders/...`, and `process.cwd()` reports the
  // resolved form — so a path built from the UNRESOLVED `dir` and one the
  // command resolved compare unequal here and equal on Linux. That is a test
  // that only holds in CI, which is the one place a test cannot be debugged.
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "mcpjam-suite-file-"))
  );
  const previous = process.cwd();
  try {
    process.chdir(dir);
    return await run(dir);
  } finally {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  }
}

// ── the file under test ──────────────────────────────────────────────────────

const VALID_SUITE_FILE = `schemaVersion: "1"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_billing
  name: Billing smoke
target:
  servers:
    - name: billing
defaults:
  model: anthropic/claude-sonnet-4-6
  repetitions: 5
  passThreshold: 0.8
  validity: {}
cases:
  - id: c_refund
    title: Refunds a duplicate charge
    steps:
      - id: step-1
        kind: prompt
        prompt: Refund the duplicate charge on invoice 4471.
`;

// ── the hosted suite fixture ─────────────────────────────────────────────────

type SuiteOverrides = Record<string, unknown>;
type CaseOverrides = Record<string, unknown>;

function suiteDetail(overrides: SuiteOverrides = {}): Record<string, unknown> {
  return {
    id: "s_billing",
    name: "Billing smoke",
    description: null,
    projectId: "proj-alpha",
    environment: { servers: ["billing"], computerEnvironment: null },
    executionConfig: { model: "anthropic/claude-sonnet-4-6" },
    hosts: [],
    settings: {
      minimumAccuracy: 80,
      matchOptions: null,
      checks: [],
      judge: { enabled: false, model: null },
    },
    schedule: { enabled: false, intervalMinutes: null },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function evalCase(overrides: CaseOverrides = {}): Record<string, unknown> {
  return {
    id: "case_row_1",
    title: "Refunds a duplicate charge",
    steps: [
      {
        id: "step-1",
        kind: "prompt",
        prompt: "Refund the duplicate charge on invoice 4471.",
      },
    ],
    iterations: 5,
    isNegative: false,
    models: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

async function startSuiteFixture(state: {
  detail: Record<string, unknown>;
  cases: Record<string, unknown>[];
  nextCursor?: string;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain: nothing here takes a body, and an unread request stream keeps
      // the socket open past the response.
    }
    const url = new URL(req.url ?? "/", "http://fixture");
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/api/v1/projects") {
      res.end(
        JSON.stringify({
          items: [
            {
              id: "proj-alpha",
              name: "Alpha",
              description: null,
              icon: null,
              organizationId: "org-1",
              visibility: null,
              createdAt: 1,
              updatedAt: 200,
            },
          ],
        })
      );
      return;
    }
    if (url.pathname === "/api/v1/projects/proj-alpha/eval-suites") {
      res.end(
        JSON.stringify({
          items: [
            {
              id: state.detail.id,
              name: state.detail.name,
              projectId: "proj-alpha",
              createdAt: 1,
              updatedAt: 2,
              latestRun: null,
              totals: { passed: 0, failed: 0, runs: 0 },
              passRateTrend: [],
            },
          ],
        })
      );
      return;
    }
    if (
      url.pathname ===
      `/api/v1/projects/proj-alpha/eval-suites/${state.detail.id}`
    ) {
      res.end(JSON.stringify(state.detail));
      return;
    }
    if (
      url.pathname ===
      `/api/v1/projects/proj-alpha/eval-suites/${state.detail.id}/cases`
    ) {
      res.end(
        JSON.stringify({
          items: state.cases,
          ...(state.nextCursor ? { nextCursor: state.nextCursor } : {}),
        })
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: `no route ${url.pathname}` } }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("fixture server did not bind a port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

function exportArgv(baseUrl: string, ...args: string[]): string[] {
  return [
    "node",
    "mcpjam",
    "eval",
    "export",
    ...args,
    "--api-key",
    "sk_test",
    "--api-url",
    baseUrl,
    "--format",
    "json",
  ];
}

/** Run `eval export` against a one-shot fixture built from these overrides. */
async function runExport(
  state: {
    detail?: SuiteOverrides;
    cases?: CaseOverrides[];
    nextCursor?: string;
  },
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const fixture = await startSuiteFixture({
    detail: suiteDetail(state.detail ?? {}),
    cases: (state.cases ?? [{}]).map((overrides) => evalCase(overrides)),
    ...(state.nextCursor ? { nextCursor: state.nextCursor } : {}),
  });
  try {
    const run = await captureProcessOutput(() =>
      main(exportArgv(fixture.baseUrl, ...args), {
        telemetry: telemetryDisabled,
      })
    );
    return {
      exitCode: run.result.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
    };
  } finally {
    await fixture.close();
  }
}

// ── the percent → fraction conversion ────────────────────────────────────────

describe("percentToFraction", () => {
  test("shifts the decimal point exactly, in decimal", () => {
    // `85 / 100` in binary floating point is the nearest double, and
    // `(85 / 100) * 100` is 85.00000000000001 — so a divide-then-verify
    // conversion would reject almost every percent a person has typed. These
    // are the values the hosted `minimumAccuracy` actually carries.
    const cases: Array<[number, number]> = [
      [0, 0],
      [1, 0.01],
      [7, 0.07],
      [20, 0.2],
      [80, 0.8],
      [85, 0.85],
      [99, 0.99],
      [100, 1],
      [0.5, 0.005],
      [5.5, 0.055],
      [12.345, 0.12345],
      [33.333333, 0.33333333],
      // Below 1e-6 `Number.prototype.toString` switches to exponential
      // notation. These are ordinary decimals and must convert on their
      // digits, not be refused for how JavaScript happens to print them.
      [0.0001, 0.000001],
      [0.00001, 1e-7],
      [1e-7, 1e-9],
    ];
    for (const [percent, fraction] of cases) {
      assert.equal(percentToFraction(percent), fraction, `${percent}%`);
    }
  });

  test("refuses anything it cannot represent without losing a digit", () => {
    for (const percent of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      // Percents carrying more significant digits than the shifted decimal
      // survives as a double. The file would otherwise claim a threshold
      // fractionally different from the one the dashboard grades with.
      0.1 + 0.2, // 0.30000000000000004
      12.345678901234567,
      3.0000000000000004,
    ]) {
      assert.equal(percentToFraction(percent), null, String(percent));
    }
  });
});

describe("modalRepetitions", () => {
  test("picks the most common count, smallest on a tie", () => {
    assert.equal(modalRepetitions([5, 5, 9]), 5);
    assert.equal(modalRepetitions([9, 5, 5]), 5);
    // A tie must resolve the SAME way whatever order the cases arrive in, or
    // an export's diff moves when somebody reorders the suite.
    assert.equal(modalRepetitions([9, 3]), 3);
    assert.equal(modalRepetitions([3, 9]), 3);
    assert.equal(modalRepetitions([]), 1);
  });
});

// ── eval validate ────────────────────────────────────────────────────────────

describe("eval validate", () => {
  test("exits 0 on a valid file, with no key and no server", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "suite.yaml");
      await writeFile(file, VALID_SUITE_FILE, "utf8");

      // No `--api-key`, no `--api-url`, and no fixture server is listening.
      // Anything that tried to authenticate or fetch would fail here.
      const run = await captureProcessOutput(() =>
        main(
          [
            "node",
            "mcpjam",
            "eval",
            "validate",
            "--file",
            file,
            "--format",
            "json",
          ],
          { telemetry: telemetryDisabled }
        )
      );

      assert.equal(run.result.exitCode, 0);
      const payload = JSON.parse(run.stdout);
      assert.equal(payload.valid, true);
      assert.equal(payload.suite.id, "s_billing");
      assert.equal(payload.suite.cases, 1);
      assert.deepEqual(payload.findings, []);
    });
  });

  test("takes no --project: project-aware validation is a later step", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "suite.yaml");
      await writeFile(file, VALID_SUITE_FILE, "utf8");
      const run = await captureProcessOutput(() =>
        main(
          [
            "node",
            "mcpjam",
            "eval",
            "validate",
            "--file",
            file,
            "--project",
            "Alpha",
            "--format",
            "json",
          ],
          { telemetry: telemetryDisabled }
        )
      );
      assert.notEqual(run.result.exitCode, 0);
      assert.match(run.stderr, /unknown option '--project'/i);
    });
  });

  test("exits 1 when the file parsed but lost on the contract", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "suite.yaml");
      await writeFile(
        file,
        VALID_SUITE_FILE.replace("id: c_refund", 'id: "not a valid id"'),
        "utf8"
      );
      const run = await captureProcessOutput(() =>
        main(
          [
            "node",
            "mcpjam",
            "eval",
            "validate",
            "--file",
            file,
            "--format",
            "json",
          ],
          { telemetry: telemetryDisabled }
        )
      );

      assert.equal(run.result.exitCode, 1);
      const payload = JSON.parse(run.stdout);
      assert.equal(payload.valid, false);
      assert.equal(payload.stage, "contract");
      assert.equal(payload.findings[0].pointer, "cases[0].id");
      assert.equal(payload.findings[0].code, "SUITE_FILE_INVALID");
    });
  });

  test("reports every finding, not just the first", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "suite.yaml");
      await writeFile(
        file,
        VALID_SUITE_FILE.replace(
          "  passThreshold: 0.8",
          "  passThreshold: 85"
        ).replace("mode: agentWorkflow", "mode: serverContract"),
        "utf8"
      );
      const run = await captureProcessOutput(() =>
        main(
          [
            "node",
            "mcpjam",
            "eval",
            "validate",
            "--file",
            file,
            "--format",
            "json",
          ],
          { telemetry: telemetryDisabled }
        )
      );

      assert.equal(run.result.exitCode, 1);
      const payload = JSON.parse(run.stdout);
      assert.ok(payload.findings.length >= 2, run.stdout);
      const pointers = payload.findings.map(
        (entry: { pointer: string }) => entry.pointer
      );
      assert.ok(pointers.includes("mode"), run.stdout);
      assert.ok(pointers.includes("defaults.passThreshold"), run.stdout);
      // A reserved value is reported AS RESERVED, not as a generic enum miss.
      const mode = payload.findings.find(
        (entry: { pointer: string }) => entry.pointer === "mode"
      );
      assert.match(mode.message, /reserved/);
    });
  });

  test("exits 2 on malformed YAML, and names a location", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "suite.yaml");
      await writeFile(file, "suite:\n  id: [1, 2\n  name: broken\n", "utf8");
      const run = await captureProcessOutput(() =>
        main(
          [
            "node",
            "mcpjam",
            "eval",
            "validate",
            "--file",
            file,
            "--format",
            "json",
          ],
          { telemetry: telemetryDisabled }
        )
      );

      assert.equal(run.result.exitCode, 2);
      const payload = JSON.parse(run.stdout);
      assert.equal(payload.stage, "parse");
      assert.equal(payload.findings[0].code, "SUITE_FILE_YAML_INVALID");
      assert.ok(payload.findings[0].location.line > 0);
    });
  });

  test("exits 2 on an unreadable file", async () => {
    await withTempDir(async (dir) => {
      const run = await captureProcessOutput(() =>
        main(
          [
            "node",
            "mcpjam",
            "eval",
            "validate",
            "--file",
            path.join(dir, "does-not-exist.yaml"),
            "--format",
            "json",
          ],
          { telemetry: telemetryDisabled }
        )
      );
      assert.equal(run.result.exitCode, 2);
      assert.match(JSON.parse(run.stderr).error.code, /USAGE_ERROR/);
    });
  });

  test("exits 2 on an oversize file, and truncates nothing", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "suite.yaml");
      const padding = "#".repeat(
        1_048_577 - Buffer.byteLength(VALID_SUITE_FILE)
      );
      await writeFile(file, `${VALID_SUITE_FILE}${padding}`, "utf8");
      const run = await captureProcessOutput(() =>
        main(
          [
            "node",
            "mcpjam",
            "eval",
            "validate",
            "--file",
            file,
            "--format",
            "json",
          ],
          { telemetry: telemetryDisabled }
        )
      );

      assert.equal(run.result.exitCode, 2);
      const payload = JSON.parse(run.stdout);
      assert.equal(payload.stage, "input");
      assert.equal(payload.findings[0].code, "SUITE_FILE_TOO_LARGE");
      // The file on disk is untouched: rejecting is not trimming.
      assert.equal(Buffer.byteLength(await readFile(file, "utf8")), 1_048_577);
    });
  });

  test("--file - reads the suite from stdin and labels it <stdin>", async () => {
    // The one test in this file that spawns the CLI instead of calling `main()`
    // in-process. `readSuiteFileInput` reads file descriptor 0 directly, and a
    // process cannot repoint its own fd 0 from JavaScript — so the only honest
    // way to exercise the branch the docs advertise is to be a parent with a
    // pipe.
    const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const tsx = fileURLToPath(
      new URL("../../node_modules/.bin/tsx", import.meta.url)
    );

    const run = await new Promise<{ code: number; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(
          tsx,
          [cli, "eval", "validate", "--file", "-", "--format", "json"],
          {
            env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: "1" },
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
        let stdout = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
        child.stdin.end(VALID_SUITE_FILE);
      }
    );

    assert.equal(run.code, 0, run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.valid, true);
    assert.equal(payload.file, "<stdin>");
    assert.equal(payload.suite.id, "s_billing");
  });

  test("--format human says what is wrong in prose", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "suite.yaml");
      await writeFile(
        file,
        VALID_SUITE_FILE.replace("id: c_refund", 'id: "not a valid id"'),
        "utf8"
      );
      const run = await captureProcessOutput(() =>
        main(
          [
            "node",
            "mcpjam",
            "eval",
            "validate",
            "--file",
            file,
            "--format",
            "human",
          ],
          { telemetry: telemetryDisabled }
        )
      );
      assert.equal(run.result.exitCode, 1);
      assert.match(run.stdout, /invalid \(1 finding\)/);
      assert.match(run.stdout, /SUITE_FILE_INVALID cases\[0\]\.id:/);
    });
  });

  test("--format json output is byte-identical across two runs", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "suite.yaml");
      await writeFile(
        file,
        VALID_SUITE_FILE.replace("id: c_refund", 'id: "not a valid id"'),
        "utf8"
      );
      const argv = [
        "node",
        "mcpjam",
        "eval",
        "validate",
        "--file",
        file,
        "--format",
        "json",
      ];
      const first = await captureProcessOutput(() =>
        main(argv, { telemetry: telemetryDisabled })
      );
      const second = await captureProcessOutput(() =>
        main(argv, { telemetry: telemetryDisabled })
      );
      assert.equal(first.stdout, second.stdout);
      assert.equal(first.result.exitCode, second.result.exitCode);
    });
  });
});

// ── eval export ──────────────────────────────────────────────────────────────

describe("eval export", () => {
  test("writes a file that reads back as the same suite", async () => {
    await withTempDir(async (dir) => {
      const run = await runExport({}, "--suite", "Billing smoke");
      assert.equal(run.exitCode, 0, run.stderr);

      const payload = JSON.parse(run.stdout);
      assert.equal(payload.exported, true);
      assert.equal(payload.cases, 1);
      assert.equal(
        path.relative(dir, payload.path),
        path.join(".mcpjam", "evals", "s_billing.yaml")
      );

      const text = await readFile(payload.path, "utf8");
      const reloaded = loadEvalSuiteFile(text);
      assert.equal(reloaded.ok, true);
      if (!reloaded.ok) return;
      assert.equal(reloaded.authored.suite.id, "s_billing");
      assert.equal(reloaded.authored.defaults.passThreshold, 0.8);
      assert.equal(reloaded.authored.defaults.repetitions, 5);
      assert.deepEqual(reloaded.authored.target.servers, [{ name: "billing" }]);
      assert.equal(reloaded.authored.cases[0].steps[0].id, "step-1");
      // Nothing the loader resolves was written into the file.
      assert.deepEqual(reloaded.authored.defaults.validity, {});
      assert.equal(reloaded.authored.provenance, undefined);
      assert.equal(reloaded.authored.cases[0].import, undefined);
    });
  });

  test("writes the same case id every time for a legacy case", async () => {
    await withTempDir(async () => {
      // No `declaredId`: the case predates declared identity, so its id comes
      // from the platform row. Two exports must agree — a mint here would be a
      // new identity for a case that already has one, on every run.
      const first = await runExport({}, "--suite", "Billing smoke");
      assert.equal(first.exitCode, 0, first.stderr);
      const firstText = await readFile(JSON.parse(first.stdout).path, "utf8");

      const second = await runExport({}, "--suite", "Billing smoke", "--force");
      assert.equal(second.exitCode, 0, second.stderr);
      const secondText = await readFile(JSON.parse(second.stdout).path, "utf8");

      assert.equal(firstText, secondText);
      assert.match(firstText, /id: case_row_1/);
    });
  });

  test("prefers a declared id over the platform row id", async () => {
    await withTempDir(async () => {
      const run = await runExport(
        { cases: [{ declaredId: "c_declared" }] },
        "--suite",
        "Billing smoke"
      );
      assert.equal(run.exitCode, 0, run.stderr);
      const text = await readFile(JSON.parse(run.stdout).path, "utf8");
      assert.match(text, /id: c_declared/);
      assert.doesNotMatch(text, /case_row_1/);
    });
  });

  test("refuses a case whose ids are both unusable, rather than minting one", async () => {
    await withTempDir(async (dir) => {
      const run = await runExport(
        { cases: [{ id: "row id with spaces" }] },
        "--suite",
        "Billing smoke"
      );
      assert.equal(run.exitCode, 1);
      const payload = JSON.parse(run.stdout);
      assert.equal(payload.exported, false);
      assert.equal(payload.findings[0].code, "UNSUPPORTED_SUITE_EXPORT");
      assert.match(payload.findings[0].message, /never mints one/);
      assert.deepEqual(await readdir(dir), []);
    });
  });

  describe("refuses what it cannot represent, and writes nothing", () => {
    const UNSUPPORTED: Array<{
      label: string;
      state: { detail?: SuiteOverrides; cases?: CaseOverrides[] };
      pointer: string;
    }> = [
      {
        label: "host attachments have no field",
        state: { detail: { hosts: [{ id: "h1", name: "Claude Desktop" }] } },
        pointer: "hosts",
      },
      {
        label: "several attached environments",
        state: { detail: { environmentIds: ["env-a", "env-b"] } },
        pointer: "environmentIds",
      },
      {
        label: "one attached environment, whose name needs a second fetch",
        state: {
          detail: { environment: { servers: [] }, environmentIds: ["env-a"] },
        },
        pointer: "environmentIds",
      },
      {
        label: "legacy servers AND attached environments",
        state: { detail: { environmentIds: ["env-a"] } },
        pointer: "environmentIds",
      },
      {
        label: "no execution model to write as defaults.model",
        state: { detail: { executionConfig: null } },
        pointer: "executionConfig",
      },
      {
        label: "an execution system prompt",
        state: {
          detail: {
            executionConfig: { model: "m", systemPrompt: "Be terse." },
          },
        },
        pointer: "executionConfig.systemPrompt",
      },
      {
        label: "an execution temperature",
        state: {
          detail: { executionConfig: { model: "m", temperature: 0.2 } },
        },
        pointer: "executionConfig.temperature",
      },
      {
        label: "a pinned sandbox image",
        state: {
          detail: {
            environment: {
              servers: ["billing"],
              computerEnvironment: { id: "img-1", name: "ubuntu" },
            },
          },
        },
        pointer: "environment.computerEnvironment",
      },
      {
        label: "no server selection at all",
        state: { detail: { environment: { servers: [] } } },
        pointer: "environment.servers",
      },
      {
        label: "no minimum accuracy to become passThreshold",
        state: {
          detail: {
            settings: {
              minimumAccuracy: null,
              matchOptions: null,
              checks: [],
              judge: { enabled: false, model: null },
            },
          },
        },
        pointer: "settings.minimumAccuracy",
      },
      {
        label: "an iterations floor that raises a case",
        state: {
          detail: {
            settings: {
              minimumAccuracy: 80,
              minimumIterations: 9,
              matchOptions: null,
              checks: [],
              judge: { enabled: false, model: null },
            },
          },
        },
        pointer: "settings.minimumIterations",
      },
      {
        label: "non-default suite match options",
        state: {
          detail: {
            settings: {
              minimumAccuracy: 80,
              matchOptions: {
                toolCallOrder: "exact",
                extraToolCalls: 0,
                arguments: "exact",
              },
              checks: [],
              judge: { enabled: false, model: null },
            },
          },
        },
        pointer: "settings.matchOptions",
      },
      {
        label: "LLM-as-judge grading",
        state: {
          detail: {
            settings: {
              minimumAccuracy: 80,
              matchOptions: null,
              checks: [],
              judge: { enabled: true, model: "anthropic/claude-sonnet-4-6" },
            },
          },
        },
        pointer: "settings.judge",
      },
      {
        label: "a compare-across-models case",
        state: {
          cases: [
            {
              models: [
                { model: "anthropic/claude-sonnet-4-6" },
                { model: "openai/gpt-5" },
              ],
            },
          ],
        },
        pointer: "cases[0].models",
      },
      {
        label: "cases that disagree about their provider",
        state: {
          cases: [
            { models: [{ model: "m", provider: "anthropic" }] },
            { id: "case_row_2", models: [{ model: "m", provider: "openai" }] },
          ],
        },
        pointer: "cases[1].models[0].provider",
      },
      {
        label: "a scenario-bound case",
        state: { cases: [{ scenario: "checkout" }] },
        pointer: "cases[0].scenario",
      },
      {
        label: "a case that replaces the suite's checks",
        state: {
          cases: [
            { checks: { mode: "replace", list: [{ type: "noToolErrors" }] } },
          ],
        },
        pointer: "cases[0].checks",
      },
      {
        label: "a case that inherits AND carries its own checks",
        state: {
          cases: [
            { checks: { mode: "inherit", list: [{ type: "noToolErrors" }] } },
          ],
        },
        pointer: "cases[0].checks.list",
      },
      {
        label: "non-default case match options",
        state: {
          cases: [
            {
              matchOptions: {
                toolCallOrder: "exact",
                extraToolCalls: "unlimited",
                arguments: "partial",
              },
            },
          ],
        },
        pointer: "cases[0].matchOptions",
      },
      {
        label: "a suite with no cases",
        state: { cases: [] },
        pointer: "cases",
      },
      {
        label: "a case with no steps",
        state: { cases: [{ steps: [] }] },
        pointer: "cases[0].steps",
      },
      {
        label: "a suite check the predicate contract does not recognise",
        state: {
          detail: {
            settings: {
              minimumAccuracy: 80,
              matchOptions: null,
              checks: [{ type: "notAPredicate" }],
              judge: { enabled: false, model: null },
            },
          },
        },
        pointer: "cases[0].assertions[0].type",
      },
    ];

    for (const row of UNSUPPORTED) {
      test(row.label, async () => {
        await withTempDir(async (dir) => {
          const run = await runExport(row.state, "--suite", "Billing smoke");
          assert.equal(
            run.exitCode,
            1,
            `${row.label}: ${run.stdout}${run.stderr}`
          );
          const payload = JSON.parse(run.stdout);
          assert.equal(payload.exported, false);
          assert.equal(payload.path, null);
          const pointers = payload.findings.map(
            (entry: { pointer: string }) => entry.pointer
          );
          assert.ok(
            pointers.includes(row.pointer),
            `${row.label}: expected ${row.pointer}, got ${JSON.stringify(
              pointers
            )}`
          );
          for (const entry of payload.findings) {
            assert.equal(entry.code, "UNSUPPORTED_SUITE_EXPORT");
          }
          // Not "the command failed" — NOTHING was created. A partial file
          // plus a non-zero exit would satisfy the weaker assertion.
          assert.deepEqual(await readdir(dir), [], row.label);
        });
      });
    }
  });

  test("--format human names every reason it refused", async () => {
    await withTempDir(async (dir) => {
      const fixture = await startSuiteFixture({
        detail: suiteDetail({ hosts: [{ id: "h1", name: "Claude Desktop" }] }),
        cases: [evalCase()],
      });
      try {
        const run = await captureProcessOutput(() =>
          main(
            [
              "node",
              "mcpjam",
              "eval",
              "export",
              "--suite",
              "Billing smoke",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl,
              "--format",
              "human",
            ],
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 1);
        assert.match(run.stdout, /Nothing was written/);
        assert.match(run.stdout, /UNSUPPORTED_SUITE_EXPORT hosts: /);
        assert.deepEqual(await readdir(dir), []);
      } finally {
        await fixture.close();
      }
    });
  });

  test("refuses a suite that serializes past the 1 MiB limit", async () => {
    await withTempDir(async (dir) => {
      // Nothing in the contract bounds a suite's total size: `expectedOutput`
      // is an unbounded string and a suite may hold 500 cases. So this is a
      // representable suite that does not fit a file, and the answer has to be
      // a refusal rather than the round-trip check's "report a CLI bug".
      const run = await runExport(
        { cases: [{ expectedOutput: "x".repeat(1_100_000) }] },
        "--suite",
        "Billing smoke"
      );
      assert.equal(run.exitCode, 1);
      const payload = JSON.parse(run.stdout);
      assert.equal(payload.exported, false);
      assert.equal(payload.path, null);
      assert.equal(payload.findings.length, 1);
      assert.equal(payload.findings[0].code, "UNSUPPORTED_SUITE_EXPORT");
      assert.match(payload.findings[0].message, /over the 1048576-byte limit/);
      assert.doesNotMatch(payload.findings[0].message, /bug in @mcpjam\/cli/);
      assert.deepEqual(await readdir(dir), []);
    });
  });

  test("refuses a suite whose cases did not fit one page", async () => {
    await withTempDir(async (dir) => {
      const run = await runExport(
        { nextCursor: "page-2" },
        "--suite",
        "Billing smoke"
      );
      assert.equal(run.exitCode, 2);
      assert.match(run.stderr, /SUITE_FILE_TRUNCATED/);
      assert.deepEqual(await readdir(dir), []);
    });
  });

  test("keeps per-case overrides that differ from the suite defaults", async () => {
    await withTempDir(async () => {
      const run = await runExport(
        {
          cases: [
            { iterations: 5 },
            {
              id: "case_row_2",
              title: "Refuses an out-of-window refund",
              iterations: 9,
              isNegative: true,
              expectedOutput: "outside the refund window",
              models: [{ model: "openai/gpt-5", provider: "openai" }],
            },
          ],
        },
        "--suite",
        "Billing smoke"
      );
      assert.equal(run.exitCode, 0, run.stderr);
      const loaded = loadEvalSuiteFile(
        await readFile(JSON.parse(run.stdout).path, "utf8")
      );
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;

      // The modal count is the suite default and the odd one out is explicit.
      assert.equal(loaded.authored.defaults.repetitions, 5);
      assert.equal(loaded.authored.cases[0].repetitions, undefined);
      assert.equal(loaded.authored.cases[1].repetitions, 9);
      assert.equal(loaded.authored.cases[1].isNegativeTest, true);
      assert.equal(
        loaded.authored.cases[1].expectedOutput,
        "outside the refund window"
      );
      assert.equal(loaded.authored.cases[1].model, "openai/gpt-5");
      assert.equal(loaded.authored.defaults.provider, "openai");

      // Resolution puts each case back on the count it was fetched with.
      assert.equal(loaded.resolved.cases[0].repetitions, 5);
      assert.equal(loaded.resolved.cases[1].repetitions, 9);
    });
  });

  test("writes the suite's checks onto every case as assertions", async () => {
    await withTempDir(async () => {
      const run = await runExport(
        {
          detail: {
            settings: {
              minimumAccuracy: 80,
              matchOptions: null,
              checks: [
                { type: "noToolErrors" },
                { type: "responseContains", needle: "refunded" },
              ],
              judge: { enabled: false, model: null },
            },
          },
        },
        "--suite",
        "Billing smoke"
      );
      assert.equal(run.exitCode, 0, run.stderr);
      const loaded = loadEvalSuiteFile(
        await readFile(JSON.parse(run.stdout).path, "utf8")
      );
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.deepEqual(loaded.authored.cases[0].assertions, [
        { type: "noToolErrors" },
        { type: "responseContains", needle: "refunded" },
      ]);
    });
  });

  test("refuses to overwrite without --force, and replaces with it", async () => {
    await withTempDir(async (dir) => {
      const out = path.join(dir, "suite.yaml");
      await writeFile(out, "# do not clobber me\n", "utf8");

      const refused = await runExport(
        {},
        "--suite",
        "Billing smoke",
        "--out",
        out
      );
      assert.equal(refused.exitCode, 2);
      assert.match(refused.stderr, /--force/);
      assert.equal(await readFile(out, "utf8"), "# do not clobber me\n");

      const forced = await runExport(
        {},
        "--suite",
        "Billing smoke",
        "--out",
        out,
        "--force"
      );
      assert.equal(forced.exitCode, 0, forced.stderr);
      assert.match(await readFile(out, "utf8"), /schemaVersion: "1"/);
    });
  });

  test("a failed write leaves the destination intact and no .tmp behind", async () => {
    await withTempDir(async (dir) => {
      // A non-empty DIRECTORY where the file should go. The temp file is
      // written and fsynced normally and then the `rename` onto it fails —
      // which is the branch that has to clean up after itself. Chmod would not
      // do: CI runs as root, and root writes through a read-only directory.
      const target = path.join(dir, "suite.yaml");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(target);
      await writeFile(path.join(target, "keep.txt"), "untouched\n", "utf8");

      const run = await runExport(
        {},
        "--suite",
        "Billing smoke",
        "--out",
        target,
        "--force"
      );

      assert.notEqual(run.exitCode, 0, run.stdout);
      // The destination is exactly as it was...
      assert.deepEqual(await readdir(target), ["keep.txt"]);
      assert.equal(
        await readFile(path.join(target, "keep.txt"), "utf8"),
        "untouched\n"
      );
      // ...and the sibling temp file was removed rather than left behind.
      const leftovers = (await readdir(dir)).filter((name) =>
        name.endsWith(".tmp")
      );
      assert.deepEqual(leftovers, []);
    });
  });
});
