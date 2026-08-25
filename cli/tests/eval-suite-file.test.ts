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
  fractionToPercent,
  modalRepetitions,
  percentToFraction,
} from "../src/lib/eval-suite-export.js";
import {
  deriveFileRunIdempotencyKey,
  fileCaseToCreateBody,
  fileCaseToUpdateBody,
  looksLikeCreateEvalApiJson,
  looksLikeVersionedSuiteFile,
  sha256HexOfBuffer,
} from "../src/lib/eval-run-file.js";
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
    if (url.pathname === "/api/v1/projects/proj-alpha/environments") {
      const environmentIds =
        (state.detail.environmentIds as string[] | undefined) ?? [];
      res.end(
        JSON.stringify({
          items: environmentIds.map((id, index) => ({
            id,
            name: index === 0 ? "Production" : `Environment ${index + 1}`,
            projectId: "proj-alpha",
            hostId: "h1",
            standaloneServerIds: [],
            selectedServerIds: [],
            pluginPins: [],
            modelId: null,
            revision: 1,
            archived: false,
            createdAt: 1,
            updatedAt: 2,
          })),
        })
      );
      return;
    }
    const environmentResolve =
      /^\/api\/v1\/projects\/proj-alpha\/environments\/([^/]+)\/resolve$/.exec(
        url.pathname
      );
    if (environmentResolve) {
      res.end(
        JSON.stringify({
          environment: {
            id: environmentResolve[1],
            name: "Production",
            revision: 1,
          },
          host: { id: "h1", name: "Claude Desktop" },
          servers: [],
          selectedServerIds: [],
          plugins: [],
          model: null,
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
    "cloud",
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

describe("fractionToPercent", () => {
  test("is the inverse of percentToFraction on the hosted values", () => {
    const percents = [
      0, 1, 7, 20, 80, 85, 99, 100, 0.5, 5.5, 12.345, 33.333333, 0.0001,
      0.00001, 1e-7,
    ];
    for (const percent of percents) {
      const fraction = percentToFraction(percent);
      assert.notEqual(fraction, null, `${percent}%`);
      assert.equal(fractionToPercent(fraction!), percent, `${percent}%`);
    }
  });

  test("refuses anything it cannot represent without losing a digit", () => {
    for (const fraction of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      // More significant digits than a double keeps after the two-place
      // left-shift. `0.1 + 0.2` is the refuse case the OTHER direction
      // (`percentToFraction`); shifting it left lands on a representable
      // percent, so it is not a loss here.
      Number("0.123456789012345678"),
    ]) {
      assert.equal(fractionToPercent(fraction), null, String(fraction));
    }
  });
});

describe("directed --file overload", () => {
  test("sniffs a versioned suite file in YAML and JSON", () => {
    assert.equal(looksLikeVersionedSuiteFile(VALID_SUITE_FILE), true);
    assert.equal(
      looksLikeVersionedSuiteFile(
        JSON.stringify({
          schemaVersion: "1",
          mode: "agentWorkflow",
          suite: { id: "s_billing", name: "Billing" },
        })
      ),
      true
    );
    assert.equal(looksLikeVersionedSuiteFile('{"name":"smoke","cases":[]}'), false);
  });

  test("detects create-API JSON and ignores suite files", () => {
    assert.equal(
      looksLikeCreateEvalApiJson(
        JSON.stringify({
          name: "Authored smoke",
          cases: [{ title: "echo", steps: [] }],
        })
      ),
      true
    );
    assert.equal(
      looksLikeCreateEvalApiJson(
        JSON.stringify({
          name: "Authored smoke",
          tests: [{ title: "echo", steps: [] }],
        })
      ),
      true
    );
    assert.equal(looksLikeCreateEvalApiJson(VALID_SUITE_FILE), false);
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
            "cloud",
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
            "cloud",
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
            "cloud",
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
            "cloud",
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
            "cloud",
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
            "cloud",
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
            "cloud",
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
          [cli, "cloud", "eval", "validate", "--file", "-", "--format", "json"],
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
            "cloud",
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
        "cloud",
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
  test("writes declaredId as suite.id for a file-owned suite", async () => {
    await withTempDir(async () => {
      const run = await runExport(
        { detail: { declaredId: "s_billing_file" } },
        "--suite",
        "Billing smoke"
      );
      assert.equal(run.exitCode, 0, run.stderr);
      const loaded = loadEvalSuiteFile(
        await readFile(JSON.parse(run.stdout).path, "utf8")
      );
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.equal(loaded.authored.suite.id, "s_billing_file");
    });
  });

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

  test("exports execution config, hosts, and one resolved environment", async () => {
    await withTempDir(async () => {
      const run = await runExport(
        {
          detail: {
            environment: { servers: [], computerEnvironment: null },
            environmentIds: ["env-a"],
            executionConfig: {
              model: "anthropic/claude-sonnet-4-6",
              systemPrompt: "Be terse.",
              temperature: 0.2,
            },
            hosts: [
              {
                id: "h1",
                name: "Claude Desktop",
                servers: ["billing"],
              },
            ],
            settings: {
              minimumAccuracy: 80,
              matchOptions: null,
              checks: [],
              judge: {
                enabled: true,
                autoRun: false,
                model: "anthropic/claude-sonnet-4-6",
              },
            },
          },
        },
        "--suite",
        "Billing smoke"
      );
      assert.equal(run.exitCode, 0, run.stderr);
      const reloaded = loadEvalSuiteFile(
        await readFile(JSON.parse(run.stdout).path, "utf8")
      );
      assert.equal(reloaded.ok, true);
      if (!reloaded.ok) return;
      assert.equal(reloaded.authored.target.environment, "Production");
      assert.deepEqual(reloaded.authored.target.servers, undefined);
      assert.deepEqual(reloaded.authored.target.hosts, [
        {
          id: "h1",
          name: "Claude Desktop",
          servers: [{ name: "billing" }],
        },
      ]);
      assert.equal(reloaded.authored.defaults.systemPrompt, "Be terse.");
      assert.equal(reloaded.authored.defaults.temperature, 0.2);
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
        label: "several attached environments",
        state: {
          detail: {
            environment: { servers: [] },
            environmentIds: ["env-a", "env-b"],
          },
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
        pointer: "environment",
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
              judge: {
                enabled: true,
                autoRun: true,
                model: "anthropic/claude-sonnet-4-6",
              },
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
        detail: suiteDetail({
          environment: { servers: [] },
          environmentIds: ["env-a", "env-b"],
        }),
        cases: [evalCase()],
      });
      try {
        const run = await captureProcessOutput(() =>
          main(
            [
              "node",
              "mcpjam",
              "cloud",
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
        assert.match(
          run.stdout,
          /UNSUPPORTED_SUITE_EXPORT environmentIds: /
        );
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

// ── eval run --file ──────────────────────────────────────────────────────────

function runFileArgv(baseUrl: string, ...args: string[]): string[] {
  return [
    "node",
    "mcpjam",
    "cloud",
    "eval",
    "run",
    ...args,
    "--api-key",
    "sk_test",
    "--api-url",
    baseUrl,
    "--format",
    "json",
  ];
}

function suiteFileWithCases(count: number): string {
  const cases = Array.from({ length: count }, (_, i) =>
    [
      `  - id: c_case_${i}`,
      `    title: Case ${i}`,
      `    steps:`,
      `      - id: step-${i}`,
      `        kind: prompt`,
      `        prompt: Do thing ${i}.`,
    ].join("\n")
  ).join("\n");
  return `schemaVersion: "1"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_bulk
  name: Bulk
target:
  servers:
    - name: billing
defaults:
  model: anthropic/claude-sonnet-4-6
  repetitions: 1
  passThreshold: 0.8
  validity: {}
cases:
${cases}
`;
}

async function startFileRunFixture(options?: {
  existingCases?: Array<{ id: string; declaredId: string; title: string }>;
  existingHosts?: Array<{
    id: string;
    name: string;
    servers?: string[];
  }>;
  environmentName?: string;
  /**
   * Batch-create indexes to put in `failed` instead of `created`. Used to
   * assert CASE_SYNC_FAILED reports landed writes, not attempted totals.
   */
  failCreateIndexes?: readonly number[];
  failUpdates?: boolean;
}): Promise<{
  baseUrl: string;
  authHeaders: string[];
  fromFileBodies: unknown[];
  batchBodies: unknown[];
  updateBodies: unknown[];
  deletedCaseIds: string[];
  suitePatches: unknown[];
  runBodies: unknown[];
  close: () => Promise<void>;
}> {
  const authHeaders: string[] = [];
  const fromFileBodies: unknown[] = [];
  const batchBodies: unknown[] = [];
  const updateBodies: unknown[] = [];
  const deletedCaseIds: string[] = [];
  const suitePatches: unknown[] = [];
  const runBodies: unknown[] = [];
  let environmentIds: string[] = [];
  let hosts: Array<{ id: string; name: string; servers?: string[] }> = [
    ...(options?.existingHosts ?? []),
  ];
  const casesByDeclaredId = new Map<
    string,
    { id: string; declaredId: string; title: string }
  >();
  for (const row of options?.existingCases ?? []) {
    casesByDeclaredId.set(row.declaredId, row);
  }
  const runsByKey = new Map<string, string>();
  let runCounter = 0;

  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
    }
    authHeaders.push(req.headers.authorization ?? "");
    const url = new URL(req.url ?? "/", "http://fixture");
    res.setHeader("content-type", "application/json");
    const method = req.method ?? "GET";

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

    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites/from-file" &&
      method === "POST"
    ) {
      const body = raw ? JSON.parse(raw) : {};
      fromFileBodies.push(body);
      res.statusCode = fromFileBodies.length === 1 ? 201 : 200;
      res.end(
        JSON.stringify({
          created: fromFileBodies.length === 1,
          suite: {
            id: "suite-file-1",
            declaredId: body.declaredSuiteId,
            name: body.name ?? "Billing smoke",
            description: null,
            projectId: "proj-alpha",
            environment: { servers: ["billing"], computerEnvironment: null },
            executionConfig: { model: body.defaultConfig?.modelId ?? "m" },
            hosts,
            environmentIds: [],
            settings: {},
            schedule: {},
            createdAt: 1,
            updatedAt: 2,
          },
        })
      );
      return;
    }

    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-suites/suite-file-1/cases" &&
      method === "GET"
    ) {
      res.end(JSON.stringify({ items: [...casesByDeclaredId.values()] }));
      return;
    }

    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-suites/suite-file-1/cases/batch" &&
      method === "POST"
    ) {
      const body = raw ? JSON.parse(raw) : {};
      batchBodies.push(body);
      const created: Array<{
        index: number;
        id: string;
        declaredId: string;
        title: string;
        replayed: boolean;
      }> = [];
      const failed: Array<{
        index: number;
        declaredId: string;
        code: string;
        message: string;
      }> = [];
      const failCreate = new Set(options?.failCreateIndexes ?? []);
      (body.cases as Array<{ id?: string; title: string }>).forEach(
        (testCase, index) => {
          const declaredId = testCase.id ?? `minted_${index}`;
          if (failCreate.has(index)) {
            failed.push({
              index,
              declaredId,
              code: "CREATE_FAILED",
              message: `fixture refused ${declaredId}`,
            });
            return;
          }
          const id = `row_${declaredId}`;
          casesByDeclaredId.set(declaredId, {
            id,
            declaredId,
            title: testCase.title,
          });
          created.push({
            index,
            id,
            declaredId,
            title: testCase.title,
            replayed: false,
          });
        }
      );
      res.statusCode = 201;
      res.end(JSON.stringify({ created, failed, duplicatePolicy: "block" }));
      return;
    }

    if (
      url.pathname.startsWith(
        "/api/v1/projects/proj-alpha/eval-suites/suite-file-1/cases/"
      ) &&
      method === "PATCH"
    ) {
      updateBodies.push(raw ? JSON.parse(raw) : {});
      if (options?.failUpdates) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { code: "UPDATE_FAILED", message: "fixture update failed" } }));
        return;
      }
      res.end(JSON.stringify({ id: "row_c_refund", title: "updated" }));
      return;
    }

    if (
      url.pathname.startsWith(
        "/api/v1/projects/proj-alpha/eval-suites/suite-file-1/cases/"
      ) &&
      method === "DELETE"
    ) {
      const caseId = url.pathname.split("/").pop() ?? "";
      deletedCaseIds.push(caseId);
      for (const [declaredId, row] of casesByDeclaredId) {
        if (row.id === caseId) {
          casesByDeclaredId.delete(declaredId);
          break;
        }
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ id: caseId, deleted: true }));
      return;
    }

    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites" &&
      method === "GET"
    ) {
      res.end(
        JSON.stringify({
          items: [
            {
              id: "suite-file-1",
              name: "Billing smoke",
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
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites/suite-file-1" &&
      method === "GET"
    ) {
      res.end(
        JSON.stringify({
          id: "suite-file-1",
          declaredId: "s_billing",
          name: "Billing smoke",
          description: null,
          projectId: "proj-alpha",
          environment: { servers: ["billing"] },
          executionConfig: { model: "anthropic/claude-sonnet-4-6" },
          hosts,
          environmentIds,
          settings: {},
          schedule: {},
          createdAt: 1,
          updatedAt: 2,
        })
      );
      return;
    }

    if (
      url.pathname === "/api/v1/projects/proj-alpha/environments" &&
      method === "GET"
    ) {
      res.end(
        JSON.stringify({
          items: [
            {
              id: "env-prod",
              name: options?.environmentName ?? "prod",
              archived: false,
            },
          ],
        })
      );
      return;
    }

    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites/suite-file-1" &&
      method === "PATCH"
    ) {
      const body = raw ? JSON.parse(raw) : {};
      suitePatches.push(body);
      if (Array.isArray(body.environmentIds)) {
        environmentIds = body.environmentIds;
      }
      if (Array.isArray(body.hosts)) {
        hosts = body.hosts.map(
          (host: { host: string; servers?: string[] }, index: number) => ({
            id: host.host,
            name: index === 0 ? "Claude Desktop" : host.host,
            ...(host.servers ? { servers: host.servers } : {}),
          })
        );
      }
      res.end(
        JSON.stringify({
          id: "suite-file-1",
          declaredId: "s_billing",
          name: "Billing smoke",
          description: null,
          projectId: "proj-alpha",
          environment: { servers: ["billing"] },
          executionConfig: { model: "anthropic/claude-sonnet-4-6" },
          hosts,
          environmentIds,
          settings: {},
          schedule: {},
          createdAt: 1,
          updatedAt: 2,
        })
      );
      return;
    }

    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs" &&
      method === "POST"
    ) {
      const body = raw ? JSON.parse(raw) : {};
      runBodies.push(body);
      const key =
        typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
      let runId = runsByKey.get(key);
      if (!runId) {
        runCounter += 1;
        runId = `run-file-${runCounter}`;
        if (key) runsByKey.set(key, runId);
      }
      res.statusCode = 202;
      res.end(
        JSON.stringify({
          runId,
          suiteId: "suite-file-1",
          status: "running",
          caseUpsert: { committed: [], failed: [] },
          servers: [{ id: "srv-billing", name: "billing" }],
          environment: null,
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
    authHeaders,
    fromFileBodies,
    batchBodies,
    updateBodies,
    deletedCaseIds,
    suitePatches,
    runBodies,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

describe("eval run --file", () => {
  test("invalid file exits 2 after auth and creates no run", async () => {
    const fixture = await startFileRunFixture();
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(
          file,
          VALID_SUITE_FILE.replace("id: c_refund", 'id: "not a valid id"'),
          "utf8"
        );
        const run = await captureProcessOutput(() =>
          main(runFileArgv(fixture.baseUrl, "--file", file), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stderr);
        assert.ok(fixture.authHeaders.length > 0, "auth request must arrive first");
        assert.equal(fixture.fromFileBodies.length, 0);
        assert.equal(fixture.runBodies.length, 0);
        assert.match(run.stderr, /SUITE_FILE_INVALID/);
      });
    } finally {
      await fixture.close();
    }
  });

  test("valid file creates one run with the declared ids", async () => {
    const fixture = await startFileRunFixture();
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(file, VALID_SUITE_FILE, "utf8");
        const expectedHash = sha256HexOfBuffer(Buffer.from(VALID_SUITE_FILE));
        const run = await captureProcessOutput(() =>
          main(runFileArgv(fixture.baseUrl, "--file", file, "--project", "Alpha"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        assert.equal(fixture.fromFileBodies.length, 1);
        const synced = fixture.fromFileBodies[0] as Record<string, unknown>;
        assert.equal(synced.declaredSuiteId, "s_billing");
        assert.equal(synced.sourceHash, expectedHash);
        assert.deepEqual(synced.defaultConfig, {
          modelId: "anthropic/claude-sonnet-4-6",
        });
        assert.equal(fixture.batchBodies.length, 1);
        const batch = fixture.batchBodies[0] as { cases: Array<{ id: string }> };
        assert.equal(batch.cases[0].id, "c_refund");
        assert.equal(fixture.runBodies.length, 1);
        const launched = fixture.runBodies[0] as Record<string, unknown>;
        assert.equal(launched.suiteId, "suite-file-1");
        assert.equal(launched.sourceHash, expectedHash);
        assert.equal(typeof launched.idempotencyKey, "string");
        assert.deepEqual(launched.caseIds, ["row_c_refund"]);
        const payload = JSON.parse(run.stdout);
        assert.equal(payload.outcome, "started");
        assert.equal(payload.runId, "run-file-1");
      });
    } finally {
      await fixture.close();
    }
  });

  test("sends authored execution config and launches attached hosts", async () => {
    const fixture = await startFileRunFixture();
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        const configured = VALID_SUITE_FILE.replace(
          "target:\n  servers:\n    - name: billing\n",
          "target:\n  servers:\n    - name: billing\n  hosts:\n    - id: h1\n      name: Claude Desktop\n      servers:\n        - id: srv_billing\n          name: billing\n"
        ).replace(
          "  model: anthropic/claude-sonnet-4-6\n",
          "  model: anthropic/claude-sonnet-4-6\n  systemPrompt: Be terse.\n  temperature: 0.2\n"
        );
        await writeFile(file, configured, "utf8");
        const run = await captureProcessOutput(() =>
          main(
            runFileArgv(
              fixture.baseUrl,
              "--file",
              file,
              "--project",
              "Alpha"
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        const synced = fixture.fromFileBodies[0] as {
          defaultConfig: Record<string, unknown>;
        };
        assert.deepEqual(synced.defaultConfig, {
          modelId: "anthropic/claude-sonnet-4-6",
          systemPrompt: "Be terse.",
          temperature: 0.2,
        });
        assert.deepEqual(fixture.suitePatches, [
          {
            hosts: [
              {
                host: "h1",
                servers: ["srv_billing"],
              },
            ],
          },
        ]);
        assert.equal(
          (fixture.runBodies[0] as { namedHostId?: string }).namedHostId,
          "h1"
        );
      });
    } finally {
      await fixture.close();
    }
  });

  test("an explicit host target does not replace the file's host attachments", async () => {
    const fixture = await startFileRunFixture({
      existingHosts: [{ id: "h-existing", name: "Existing Host" }],
    });
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        const configured = VALID_SUITE_FILE.replace(
          "target:\n  servers:\n    - name: billing\n",
          "target:\n  servers:\n    - name: billing\n  hosts:\n    - id: h-file\n      name: File Host\n"
        );
        await writeFile(file, configured, "utf8");
        const run = await captureProcessOutput(() =>
          main(
            runFileArgv(
              fixture.baseUrl,
              "--file",
              file,
              "--project",
              "Alpha",
              "--host",
              "h-existing"
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        assert.deepEqual(fixture.suitePatches, []);
        assert.equal(
          (fixture.runBodies[0] as { namedHostId?: string }).namedHostId,
          "h-existing"
        );
      });
    } finally {
      await fixture.close();
    }
  });

  test("same file twice with one idempotency key starts exactly one run", async () => {
    const fixture = await startFileRunFixture();
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(file, VALID_SUITE_FILE, "utf8");
        const argv = runFileArgv(
          fixture.baseUrl,
          "--file",
          file,
          "--project",
          "Alpha",
          "--idempotency-key",
          "file-key-1"
        );
        const first = await captureProcessOutput(() =>
          main(argv, { telemetry: telemetryDisabled })
        );
        const second = await captureProcessOutput(() =>
          main(argv, { telemetry: telemetryDisabled })
        );
        assert.equal(first.result.exitCode, 0, first.stderr);
        assert.equal(second.result.exitCode, 0, second.stderr);
        assert.equal(fixture.runBodies.length, 2);
        const ids = [first, second].map(
          (entry) => JSON.parse(entry.stdout).runId
        );
        assert.deepEqual(ids, ["run-file-1", "run-file-1"]);
        assert.equal(
          (fixture.runBodies[0] as { idempotencyKey: string }).idempotencyKey,
          "file-key-1"
        );
        assert.equal(fixture.updateBodies.length, 1);
        const updated = fixture.updateBodies[0] as Record<string, unknown>;
        assert.equal(updated.id, undefined);
        assert.equal(updated.title, "Refunds a duplicate charge");
        assert.equal(updated.isNegative, false);
        assert.equal(updated.checks, null);
      });
    } finally {
      await fixture.close();
    }
  });

  test("repetitions: 50 is refused naming the hosted cap of 10", async () => {
    const fixture = await startFileRunFixture();
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(
          file,
          VALID_SUITE_FILE.replace("repetitions: 5", "repetitions: 50"),
          "utf8"
        );
        const run = await captureProcessOutput(() =>
          main(runFileArgv(fixture.baseUrl, "--file", file, "--project", "Alpha"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stderr);
        assert.match(run.stderr, /REPETITIONS_CAP/);
        assert.match(run.stderr, /10/);
        assert.equal(fixture.fromFileBodies.length, 0);
        assert.equal(fixture.runBodies.length, 0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("250-case file uploads in three batches", async () => {
    const fixture = await startFileRunFixture();
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(file, suiteFileWithCases(250), "utf8");
        const run = await captureProcessOutput(() =>
          main(runFileArgv(fixture.baseUrl, "--file", file, "--project", "Alpha"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        assert.equal(fixture.batchBodies.length, 3);
        const sizes = fixture.batchBodies.map(
          (body) => (body as { cases: unknown[] }).cases.length
        );
        assert.deepEqual(sizes, [100, 100, 50]);
      });
    } finally {
      await fixture.close();
    }
  });

  test("--format json is byte-identical across two runs of the same file", async () => {
    const fixture = await startFileRunFixture();
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(file, VALID_SUITE_FILE, "utf8");
        const argv = runFileArgv(
          fixture.baseUrl,
          "--file",
          file,
          "--project",
          "Alpha",
          "--idempotency-key",
          "stable-json"
        );
        const first = await captureProcessOutput(() =>
          main(argv, { telemetry: telemetryDisabled })
        );
        const second = await captureProcessOutput(() =>
          main(argv, { telemetry: telemetryDisabled })
        );
        assert.equal(first.result.exitCode, 0, first.stderr);
        assert.equal(second.result.exitCode, 0, second.stderr);
        assert.equal(first.stdout, second.stdout);
      });
    } finally {
      await fixture.close();
    }
  });

  test("create-API JSON on eval run --file points at eval create --file", async () => {
    const fixture = await startFileRunFixture();
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "create.json");
        await writeFile(
          file,
          JSON.stringify({
            name: "Authored smoke",
            cases: [
              {
                title: "echo",
                steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
              },
            ],
          }),
          "utf8"
        );
        const run = await captureProcessOutput(() =>
          main(runFileArgv(fixture.baseUrl, "--file", file, "--project", "Alpha"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stderr);
        assert.match(run.stderr, /eval create --file/);
        assert.equal(fixture.fromFileBodies.length, 0);
        assert.equal(fixture.runBodies.length, 0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a disabled case with a passThreshold override does not refuse the run", async () => {
    const fixture = await startFileRunFixture({
      existingCases: [
        { id: "row_c_refund", declaredId: "c_refund", title: "Refunds" },
        { id: "row_c_parked", declaredId: "c_parked", title: "Parked" },
      ],
    });
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(
          file,
          `${VALID_SUITE_FILE}  - id: c_parked\n    title: Parked\n    disabled: true\n    passThreshold: 0.95\n    steps:\n      - id: step-1\n        kind: prompt\n        prompt: Parked for now.\n`,
          "utf8"
        );
        const run = await captureProcessOutput(() =>
          main(runFileArgv(fixture.baseUrl, "--file", file, "--project", "Alpha"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        assert.equal(fixture.runBodies.length, 1);
        const launched = fixture.runBodies[0] as { caseIds: string[] };
        assert.deepEqual(launched.caseIds, ["row_c_refund"]);
      });
    } finally {
      await fixture.close();
    }
  });

  test("CASE_SYNC_FAILED reports landed writes, not attempted totals", async () => {
    const fixture = await startFileRunFixture({
      failCreateIndexes: [1],
    });
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(file, suiteFileWithCases(2), "utf8");
        const run = await captureProcessOutput(() =>
          main(runFileArgv(fixture.baseUrl, "--file", file, "--project", "Alpha"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stderr);
        assert.match(run.stderr, /CASE_SYNC_FAILED/);
        const jsonLine = run.stderr
          .split("\n")
          .reverse()
          .find((line) => line.startsWith("{"));
        assert.ok(jsonLine, run.stderr);
        const payload = JSON.parse(jsonLine) as {
          error: { details: { created: number; updated: number; deleted: number } };
        };
        assert.equal(payload.error.details.created, 1);
        assert.equal(payload.error.details.updated, 0);
        assert.equal(payload.error.details.deleted, 0);
        assert.equal(fixture.runBodies.length, 0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("CASE_SYNC_FAILED counts only updates that landed", async () => {
    const fixture = await startFileRunFixture({
      existingCases: [
        { id: "row_c_refund", declaredId: "c_refund", title: "Refunds" },
      ],
      failUpdates: true,
    });
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(file, VALID_SUITE_FILE, "utf8");
        const run = await captureProcessOutput(() =>
          main(runFileArgv(fixture.baseUrl, "--file", file, "--project", "Alpha"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stderr);
        assert.match(run.stderr, /CASE_SYNC_FAILED/);
        const jsonLine = run.stderr
          .split("\n")
          .reverse()
          .find((line) => line.startsWith("{"));
        assert.ok(jsonLine, run.stderr);
        const payload = JSON.parse(jsonLine) as {
          error: { details: { created: number; updated: number } };
        };
        assert.equal(payload.error.details.created, 0);
        assert.equal(payload.error.details.updated, 0);
        assert.equal(fixture.runBodies.length, 0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a per-case passThreshold override is uploaded, not silently dropped", async () => {
    const fixture = await startFileRunFixture();
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(
          file,
          VALID_SUITE_FILE.replace(
            "    title: Refunds a duplicate charge",
            "    passThreshold: 0.95\n    title: Refunds a duplicate charge"
          ),
          "utf8"
        );
        const run = await captureProcessOutput(() =>
          main(runFileArgv(fixture.baseUrl, "--file", file, "--project", "Alpha"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        const batch = fixture.batchBodies[0] as {
          cases: Array<{ passThreshold?: number; repetitions?: number }>;
        };
        assert.equal(batch.cases[0].passThreshold, 0.95);
        assert.equal(fixture.runBodies.length, 1);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a later file deletes a case that is no longer enabled", async () => {
    const fixture = await startFileRunFixture({
      existingCases: [
        { id: "row_c_refund", declaredId: "c_refund", title: "Refunds" },
        { id: "row_c_stale", declaredId: "c_stale", title: "Removed" },
      ],
    });
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(file, VALID_SUITE_FILE, "utf8");
        const run = await captureProcessOutput(() =>
          main(runFileArgv(fixture.baseUrl, "--file", file, "--project", "Alpha"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        assert.deepEqual(fixture.deletedCaseIds, ["row_c_stale"]);
        assert.equal(fixture.batchBodies.length, 0);
        assert.equal(fixture.updateBodies.length, 1);
        const launched = fixture.runBodies[0] as { caseIds: string[] };
        assert.deepEqual(launched.caseIds, ["row_c_refund"]);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a disabled case keeps its hosted history and simply does not run", async () => {
    // `disabled: true` means "the loader skips this case (it stays in the
    // file)". Deleting the hosted row would destroy the case's iterations the
    // moment somebody parks a flaky test, and re-enabling it tomorrow would
    // not bring them back. Declared-but-disabled is kept; only cases the file
    // no longer declares AT ALL are stale.
    const fixture = await startFileRunFixture({
      existingCases: [
        { id: "row_c_refund", declaredId: "c_refund", title: "Refunds" },
        { id: "row_c_parked", declaredId: "c_parked", title: "Parked" },
      ],
    });
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(
          file,
          `${VALID_SUITE_FILE}  - id: c_parked\n    title: Parked\n    disabled: true\n    steps:\n      - id: step-1\n        kind: prompt\n        prompt: Parked for now.\n`,
          "utf8"
        );
        const run = await captureProcessOutput(() =>
          main(
            runFileArgv(fixture.baseUrl, "--file", file, "--project", "Alpha"),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        // Kept — not deleted. The parked row is updated so the hosted
        // definition matches the file; it is still left out of the launch.
        assert.deepEqual(fixture.deletedCaseIds, []);
        assert.equal(fixture.updateBodies.length, 2);
        const parkedUpdate = fixture.updateBodies.find(
          (body) => (body as { title?: string }).title === "Parked"
        ) as { title: string; steps: Array<{ prompt: string }> };
        assert.equal(parkedUpdate.steps[0]?.prompt, "Parked for now.");
        const launched = fixture.runBodies[0] as { caseIds: string[] };
        assert.deepEqual(launched.caseIds, ["row_c_refund"]);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a newly declared disabled case is created but not launched", async () => {
    const fixture = await startFileRunFixture({
      existingCases: [
        { id: "row_c_refund", declaredId: "c_refund", title: "Refunds" },
      ],
    });
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(
          file,
          `${VALID_SUITE_FILE}  - id: c_parked\n    title: Parked\n    disabled: true\n    steps:\n      - id: step-1\n        kind: prompt\n        prompt: Parked for now.\n`,
          "utf8"
        );
        const run = await captureProcessOutput(() =>
          main(
            runFileArgv(fixture.baseUrl, "--file", file, "--project", "Alpha"),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        assert.equal(fixture.batchBodies.length, 1);
        const created = (fixture.batchBodies[0] as { cases: Array<{ id: string }> })
          .cases;
        assert.deepEqual(
          created.map((entry) => entry.id),
          ["c_parked"]
        );
        const launched = fixture.runBodies[0] as { caseIds: string[] };
        assert.deepEqual(launched.caseIds, ["row_c_refund"]);
      });
    } finally {
      await fixture.close();
    }
  });

  test("updating a file-owned case clears removed negative and check fields", async () => {
    const fixture = await startFileRunFixture({
      existingCases: [
        {
          id: "row_c_refund",
          declaredId: "c_refund",
          title: "Refunds a duplicate charge",
        },
      ],
    });
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(file, VALID_SUITE_FILE, "utf8");
        const run = await captureProcessOutput(() =>
          main(runFileArgv(fixture.baseUrl, "--file", file, "--project", "Alpha"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        assert.equal(fixture.updateBodies.length, 1);
        const body = fixture.updateBodies[0] as Record<string, unknown>;
        assert.equal(body.isNegative, false);
        assert.equal(body.checks, null);
        assert.equal(body.expectedOutput, "");
      });
    } finally {
      await fixture.close();
    }
  });

  test("the same file with different --iterations is not treated as a retry", async () => {
    const fixture = await startFileRunFixture();
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(file, VALID_SUITE_FILE, "utf8");
        const first = await captureProcessOutput(() =>
          main(
            runFileArgv(
              fixture.baseUrl,
              "--file",
              file,
              "--project",
              "Alpha",
              "--iterations",
              "1"
            ),
            { telemetry: telemetryDisabled }
          )
        );
        const second = await captureProcessOutput(() =>
          main(
            runFileArgv(
              fixture.baseUrl,
              "--file",
              file,
              "--project",
              "Alpha",
              "--iterations",
              "10"
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(first.result.exitCode, 0, first.stderr);
        assert.equal(second.result.exitCode, 0, second.stderr);
        const keys = fixture.runBodies.map(
          (body) => (body as { idempotencyKey: string }).idempotencyKey
        );
        assert.equal(keys.length, 2);
        assert.notEqual(keys[0], keys[1]);
        const ids = [first, second].map(
          (entry) => JSON.parse(entry.stdout).runId
        );
        assert.deepEqual(ids, ["run-file-1", "run-file-2"]);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a file with every case disabled is refused rather than run unscoped", async () => {
    const fixture = await startFileRunFixture({
      existingCases: [
        { id: "row_c_refund", declaredId: "c_refund", title: "Refunds" },
      ],
    });
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(
          file,
          VALID_SUITE_FILE.replace(
            "    title: Refunds a duplicate charge",
            "    disabled: true\n    title: Refunds a duplicate charge"
          ),
          "utf8"
        );
        const run = await captureProcessOutput(() =>
          main(runFileArgv(fixture.baseUrl, "--file", file, "--project", "Alpha"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stderr);
        assert.match(run.stderr, /NO_ENABLED_CASES/);
        assert.equal(fixture.runBodies.length, 0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("--case cannot launch a disabled case the file still declares", async () => {
    const fixture = await startFileRunFixture({
      existingCases: [
        { id: "row_c_refund", declaredId: "c_refund", title: "Refunds" },
        { id: "row_c_parked", declaredId: "c_parked", title: "Parked" },
      ],
    });
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(
          file,
          `${VALID_SUITE_FILE}  - id: c_parked\n    title: Parked\n    disabled: true\n    steps:\n      - id: step-1\n        kind: prompt\n        prompt: Parked for now.\n`,
          "utf8"
        );
        const run = await captureProcessOutput(() =>
          main(
            runFileArgv(
              fixture.baseUrl,
              "--file",
              file,
              "--project",
              "Alpha",
              "--case",
              "c_parked"
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 2, run.stderr);
        assert.match(run.stderr, /CASE_DISABLED/);
        assert.equal(fixture.runBodies.length, 0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("defaults.repetitions is uploaded as the v2 suite policy", async () => {
    const fixture = await startFileRunFixture();
    try {
      await withTempDir(async (dir) => {
        const file = path.join(dir, "suite.yaml");
        await writeFile(
          file,
          VALID_SUITE_FILE.replace(
            "    title: Refunds a duplicate charge",
            "    repetitions: 1\n    title: Refunds a duplicate charge"
          ),
          "utf8"
        );
        const run = await captureProcessOutput(() =>
          main(runFileArgv(fixture.baseUrl, "--file", file, "--project", "Alpha"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        const synced = fixture.fromFileBodies[0] as Record<string, unknown>;
        assert.equal("minIterations" in synced, false);
        assert.equal(synced.verdictPolicyVersion, 2);
        assert.deepEqual(synced.verdictPolicyDefaults, {
          repetitions: 5,
          passThreshold: 0.8,
          validity: {
            coverage: {
              kind: "allConfiguredTrialsAttempted",
              minGradeableTrials: 1,
            },
            minCompletionRate: 0.8,
            maxEvaluatorErrorRate: 0.1,
          },
        });
        const batch = fixture.batchBodies[0] as {
          cases: Array<{ iterations: number; repetitions: number; passThreshold: number }>;
        };
        assert.equal(batch.cases[0].iterations, 1);
        assert.equal(batch.cases[0].repetitions, 1);
        assert.equal(batch.cases[0].passThreshold, 0.8);
      });
    } finally {
      await fixture.close();
    }
  });

  test("authored toolPolicy is refused while validity gates are uploaded", async () => {
    const fixture = await startFileRunFixture();
    try {
      await withTempDir(async (dir) => {
        const policyFile = path.join(dir, "policy.yaml");
        await writeFile(
          policyFile,
          VALID_SUITE_FILE.replace(
            "  validity: {}",
            "  toolPolicy:\n    mode: readOnly\n  validity: {}"
          ),
          "utf8"
        );
        const policy = await captureProcessOutput(() =>
          main(
            runFileArgv(fixture.baseUrl, "--file", policyFile, "--project", "Alpha"),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(policy.result.exitCode, 2, policy.stderr);
        assert.match(policy.stderr, /TOOL_POLICY_UNSUPPORTED/);

        const validityFile = path.join(dir, "validity.yaml");
        await writeFile(
          validityFile,
          VALID_SUITE_FILE.replace(
            "  validity: {}",
            "  validity:\n    minEligibleTrials: 3"
          ),
          "utf8"
        );
        const validity = await captureProcessOutput(() =>
          main(
            runFileArgv(
              fixture.baseUrl,
              "--file",
              validityFile,
              "--project",
              "Alpha"
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(validity.result.exitCode, 0, validity.stderr);
        const synced = fixture.fromFileBodies.at(-1) as Record<string, any>;
        assert.deepEqual(synced.verdictPolicyDefaults.validity, {
          coverage: {
            kind: "minEligibleTrials",
            minEligibleTrials: 3,
          },
          minCompletionRate: 0.8,
          maxEvaluatorErrorRate: 0.1,
        });
        assert.equal(fixture.runBodies.length, 1);
      });
    } finally {
      await fixture.close();
    }
  });

  test("an exported environment-only file runs with zero legacy servers", async () => {
    await withTempDir(async () => {
      const exported = await runExport(
        {
          detail: {
            environment: { servers: [], computerEnvironment: null },
            environmentIds: ["env-a"],
          },
        },
        "--suite",
        "Billing smoke"
      );
      assert.equal(exported.exitCode, 0, exported.stderr);
      const fixture = await startFileRunFixture({
        environmentName: "Production",
      });
      try {
        const run = await captureProcessOutput(() =>
          main(
            runFileArgv(
              fixture.baseUrl,
              "--file",
              JSON.parse(exported.stdout).path,
              "--project",
              "Alpha"
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        assert.equal(fixture.suitePatches.length, 1);
        assert.deepEqual(
          (fixture.suitePatches[0] as { environmentIds: string[] })
            .environmentIds,
          ["env-prod"]
        );
        assert.deepEqual(
          (
            fixture.fromFileBodies[0] as {
              environment: { servers: string[] };
            }
          ).environment.servers,
          []
        );
        const launched = fixture.runBodies[0] as { environmentId?: string };
        assert.equal(launched.environmentId, "env-prod");
      } finally {
        await fixture.close();
      }
    });
  });
});

describe("file-owned case bodies and idempotency", () => {
  test("an update body clears isNegative and checks when the file dropped them", () => {
    const loaded = loadEvalSuiteFile(VALID_SUITE_FILE);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const testCase = loaded.resolved.enabledCases[0];
    const created = fileCaseToCreateBody(testCase);
    assert.equal("isNegative" in created, false);
    assert.equal("checks" in created, false);
    const updated = fileCaseToUpdateBody(testCase);
    assert.equal(updated.isNegative, false);
    assert.equal(updated.checks, null);
    assert.equal(updated.expectedOutput, "");
  });

  test("derived idempotency keys differ when run knobs differ", () => {
    const shared = {
      sourceHash: "a".repeat(64),
      declaredSuiteId: "s_billing",
      projectId: "proj-alpha",
      target: { servers: [{ name: "billing" }] },
    };
    const one = deriveFileRunIdempotencyKey({
      ...shared,
      knobs: { iterations: 1 },
    });
    const ten = deriveFileRunIdempotencyKey({
      ...shared,
      knobs: { iterations: 10 },
    });
    const env = deriveFileRunIdempotencyKey({
      ...shared,
      knobs: { environment: ["prod"] },
    });
    assert.notEqual(one, ten);
    assert.notEqual(one, env);
    assert.equal(
      deriveFileRunIdempotencyKey({ ...shared, knobs: { iterations: 1 } }),
      one
    );
  });
});
