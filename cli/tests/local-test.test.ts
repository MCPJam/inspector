/**
 * `mcpjam test <file>` through the real CLI `main()`: the real flag parser,
 * binding discovery, SDK runner, report renderers and exit mapping — against
 * a real stdio MCP server spawned from a temporary `.mcp.json`. Only the
 * language model is replaced, through the internal test seam; there is no
 * credential and no paid inference anywhere in this file.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV3 } from "ai/test";
import { main } from "../src/index.js";
import { sha256HexOfBuffer } from "../src/lib/eval-run-file.js";
import { captureProcessOutput, telemetryDisabled } from "./support/cli-run.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/policy-target-server.mjs", import.meta.url)
);
const PROVIDER_KEY = "sk-ant-api03-CLISENTINELCLISENTINELCLISENTINEL";

type Step =
  | { text: string }
  | { toolCalls: Array<{ toolName: string; input?: Record<string, unknown> }> }
  | { error: unknown };

type PromptMessage = {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
};

let callCounter = 0;
function scripted(script: (userText: string, afterTool: boolean) => Step) {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = options.prompt as unknown as PromptMessage[];
      let lastUser = -1;
      prompt.forEach((message, index) => {
        if (message.role === "user") lastUser = index;
      });
      const user = prompt[lastUser];
      const userText = !user
        ? ""
        : typeof user.content === "string"
        ? user.content
        : user.content.map((part) => part.text ?? "").join("");
      const afterTool = prompt
        .slice(lastUser + 1)
        .some((message) => message.role === "tool");
      const step = script(userText, afterTool);
      if ("error" in step) throw step.error;
      const usage = {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      };
      if ("toolCalls" in step) {
        return {
          content: step.toolCalls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: `call_${++callCounter}`,
            toolName: call.toolName,
            input: JSON.stringify(call.input ?? {}),
          })),
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: step.text }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

/** Call the tool the prompt's verb names, then answer. */
const byVerb = (userText: string, afterTool: boolean): Step => {
  if (afterTool) return { text: "Done." };
  if (/delete/i.test(userText))
    return { toolCalls: [{ toolName: "delete_note", input: { id: "1" } }] };
  if (/read/i.test(userText))
    return { toolCalls: [{ toolName: "read_note", input: { id: "1" } }] };
  return { text: "Nothing to do." };
};

const CASES = {
  read: `  - id: c_read
    title: reads the note
    steps:
      - id: s1
        kind: prompt
        prompt: Read note 1
      - id: a1
        kind: assert
        assertion:
          type: toolCalledAtLeastOnce
          toolName: read_note
`,
  wantsEcho: `  - id: c_echo
    title: expects an echo it never gets
    steps:
      - id: s1
        kind: prompt
        prompt: Read note 1
      - id: a1
        kind: assert
        assertion:
          type: toolCalledAtLeastOnce
          toolName: echo
`,
  delete: `  - id: c_delete
    title: deletes the note
    steps:
      - id: s1
        kind: prompt
        prompt: Delete note 1
      - id: a1
        kind: assert
        assertion:
          type: toolCalledAtLeastOnce
          toolName: delete_note
`,
  direct: `  - id: c_direct
    title: calls a tool directly
    steps:
      - id: t1
        kind: toolCall
        serverName: notes
        toolName: read_note
        arguments: { id: "1" }
`,
};

function suite(
  cases: string,
  options: { servers?: string[]; toolPolicy?: string } = {}
): string {
  const servers = (options.servers ?? ["notes"])
    .map((name) => `    - name: ${name}`)
    .join("\n");
  return `schemaVersion: "2"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_cli_local
  name: cli local test
target:
  servers:
${servers}
defaults:
  judge:
    enabled: false
  model: anthropic/claude-haiku-4.5
  iterations: 1
  passThreshold: 1
  validity: {}
${options.toolPolicy ? `  toolPolicy:\n${options.toolPolicy}\n` : ""}cases:
${cases}`;
}

type Workspace = {
  dir: string;
  callsFile: string;
  cwdFile: string;
  calls: () => string[];
};

function workspace(
  suiteText: string,
  mcpEntry: Record<string, unknown> = {}
): Workspace {
  const dir = mkdtempSync(path.join(tmpdir(), "mcpjam-test-cli-"));
  const callsFile = path.join(dir, "calls.log");
  const cwdFile = path.join(dir, "cwd.log");
  mkdirSync(path.join(dir, ".mcpjam", "evals"), { recursive: true });
  writeFileSync(path.join(dir, ".mcpjam", "evals", "example.yaml"), suiteText);
  writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        notes: {
          command: process.execPath,
          args: [FIXTURE],
          env: {
            POLICY_TARGET_CALLS_FILE: "${CALLS_FILE}",
            POLICY_TARGET_CWD_FILE: "${CWD_FILE:-}",
          },
          ...mcpEntry,
        },
      },
    })
  );
  return {
    dir,
    callsFile,
    cwdFile,
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, "utf8")
            .split("\n")
            .filter((line) => line.length > 0)
        : [],
  };
}

async function runTest(
  ws: Workspace,
  args: string[],
  options: {
    script?: (userText: string, afterTool: boolean) => Step;
    env?: Record<string, string>;
  } = {}
) {
  const script = options.script ?? byVerb;
  return captureProcessOutput(() =>
    main(
      [
        "node",
        "mcpjam",
        "--format",
        "json",
        "test",
        ".mcpjam/evals/example.yaml",
        ...args,
      ],
      {
        telemetry: telemetryDisabled,
        localTest: {
          cwd: ws.dir,
          env: {
            PATH: process.env.PATH ?? "",
            CALLS_FILE: ws.callsFile,
            CWD_FILE: ws.cwdFile,
            ANTHROPIC_API_KEY: PROVIDER_KEY,
            ...options.env,
          },
          runtime: { createLanguageModel: () => scripted(script) as never },
        },
      }
    )
  );
}

test("passes a case over a real stdio server and prints one JSON report", async () => {
  const ws = workspace(suite(CASES.read));
  const run = await runTest(ws, []);
  assert.equal(run.result.exitCode, 0, run.stderr);
  const report = JSON.parse(run.stdout) as {
    kind: string;
    verdict: string;
    metadata: Record<string, any>;
  };
  assert.equal(report.kind, "eval-local-run");
  assert.equal(report.verdict, "passed");
  assert.equal(report.metadata.execution.mode, "local");
  assert.deepEqual(report.metadata.execution.servers, [
    { name: "notes", source: ".mcp.json", transport: "stdio" },
  ]);
  assert.equal(report.metadata.upload.requested, false);
  assert.deepEqual(ws.calls(), ["read_note"]);
  // A stdio entry without cwd runs in the invocation directory.
  assert.equal(readFileSync(ws.cwdFile, "utf8"), ws.dir);
});

test("a measured failure exits 1, and --case reruns exactly one case", async () => {
  const ws = workspace(suite(CASES.read + CASES.wantsEcho));
  const failed = await runTest(ws, []);
  assert.equal(failed.result.exitCode, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).verdict, "failed");

  const rerun = await runTest(ws, ["--case", "c_read"]);
  assert.equal(rerun.result.exitCode, 0, rerun.stderr);
  const report = JSON.parse(rerun.stdout) as {
    metadata: { selection: { selected: string[]; skipped: unknown[] } };
  };
  assert.deepEqual(report.metadata.selection.selected, ["c_read"]);
  assert.deepEqual(report.metadata.selection.skipped, [
    { caseId: "c_echo", reason: "notSelected" },
  ]);
});

test("--reporter writes one document to stdout; --out writes the artifact atomically", async () => {
  const ws = workspace(suite(CASES.read));
  const run = await runTest(ws, [
    "--reporter",
    "junit-xml",
    "--out",
    "reports/local.xml",
  ]);
  assert.equal(run.result.exitCode, 0, run.stderr);
  assert.match(run.stdout, /^<\?xml/);
  assert.match(
    run.stdout,
    /<property name="mcpjam.execution" value="local"\/>/
  );
  // Human summary and the artifact path go to stderr, never into the document.
  assert.match(run.stderr, /Local run — PASSED/);
  assert.match(run.stderr, /Report written to/);
  const artifact = readFileSync(
    path.join(ws.dir, "reports", "local.xml"),
    "utf8"
  );
  assert.match(artifact, /mcpjam\.verdict" value="passed"/);
});

test("an unsupported later case refuses the run before any server starts (exit 2)", async () => {
  const ws = workspace(suite(CASES.read + CASES.direct));
  const run = await runTest(ws, []);
  assert.equal(run.result.exitCode, 2, run.stderr);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /CASE_UNSUPPORTED/);
  assert.match(run.stderr, /c_direct/);
  assert.deepEqual(ws.calls(), []);
  assert.equal(
    existsSync(ws.cwdFile),
    false,
    "the server process must never have started"
  );
});

test("unbound target servers are listed together (exit 4)", async () => {
  const ws = workspace(
    suite(CASES.read, { servers: ["notes", "tasks", "mail"] })
  );
  const run = await runTest(ws, []);
  assert.equal(run.result.exitCode, 4, run.stderr);
  assert.match(run.stderr, /SERVER_BINDING_MISSING/);
  assert.match(run.stderr, /tasks, mail/);
});

test("missing BYOK credentials exit 3 without starting anything", async () => {
  const ws = workspace(suite(CASES.read));
  const run = await runTest(ws, ["--inference", "byok"], {
    env: { ANTHROPIC_API_KEY: "" },
  });
  assert.equal(run.result.exitCode, 3, run.stderr);
  assert.match(run.stderr, /CREDENTIALS_MISSING/);
  assert.equal(existsSync(ws.cwdFile), false);
});

test("a denied tool never reaches the server", async () => {
  const ws = workspace(
    suite(CASES.delete, {
      toolPolicy: "    mode: default\n    deny:\n      - delete_note",
    })
  );
  const run = await runTest(ws, []);
  assert.equal(run.result.exitCode, 1, run.stderr);
  assert.deepEqual(ws.calls(), []);
  const report = JSON.parse(run.stdout) as {
    metadata: {
      toolPolicy: { blocks: Array<{ toolName: string; reason: string }> };
    };
  };
  assert.deepEqual(
    report.metadata.toolPolicy.blocks.map((block) => [
      block.toolName,
      block.reason,
    ]),
    [["delete_note", "denyList"]]
  );
});

test("an unwritable --out is 4 on a pass and stays 1 on a failure", async () => {
  const ws = workspace(suite(CASES.read));
  mkdirSync(path.join(ws.dir, "taken"), { recursive: true });
  const passed = await runTest(ws, ["--out", "taken"]);
  assert.equal(passed.result.exitCode, 4, passed.stderr);

  const failing = workspace(suite(CASES.wantsEcho));
  mkdirSync(path.join(failing.dir, "taken"), { recursive: true });
  const failed = await runTest(failing, ["--out", "taken"]);
  assert.equal(failed.result.exitCode, 1, failed.stderr);
});

test("a provider outage is inconclusive (exit 5), never a failure", async () => {
  const ws = workspace(suite(CASES.read));
  const run = await runTest(ws, [], {
    script: () => ({ error: new Error("upstream 503") }),
  });
  assert.equal(run.result.exitCode, 5, run.stderr);
  assert.equal(JSON.parse(run.stdout).verdict, "inconclusive");
});

test("hashes a file saved with a byte-order mark as its bytes, as a hosted run does", async () => {
  const ws = workspace(suite(CASES.read));
  const file = path.join(ws.dir, ".mcpjam", "evals", "example.yaml");
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    readFileSync(file),
  ]);
  writeFileSync(file, bytes);
  const run = await runTest(ws, []);
  assert.equal(run.result.exitCode, 0, run.stderr);
  const report = JSON.parse(run.stdout) as {
    metadata: { suite: { sourceHash: string } };
  };
  assert.equal(report.metadata.suite.sourceHash, sha256HexOfBuffer(bytes));
});

test("no credential reaches stdout, stderr or the artifact", async () => {
  const ws = workspace(suite(CASES.read));
  const run = await runTest(ws, ["--out", "r.json"], {
    script: () => ({
      error: new Error(
        `401: x-api-key ${PROVIDER_KEY} rejected; authorization: Bearer ${PROVIDER_KEY}`
      ),
    }),
  });
  const artifact = readFileSync(path.join(ws.dir, "r.json"), "utf8");
  for (const output of [run.stdout, run.stderr, artifact]) {
    assert.ok(!output.includes(PROVIDER_KEY), output.slice(0, 400));
  }
});

test("never uploads, even with MCPJAM_API_KEY set", async () => {
  const ws = workspace(suite(CASES.read));
  const realFetch = globalThis.fetch;
  const outbound: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
    outbound.push(url);
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const run = await runTest(ws, [], {
      env: { MCPJAM_API_KEY: "sk_live_should_not_be_used" },
    });
    assert.equal(run.result.exitCode, 0, run.stderr);
  } finally {
    globalThis.fetch = realFetch;
  }
  // A BYOK run with a stdio server makes no platform request at all — and
  // no telemetry: the SDK's is suppressed for a local run, and the CLI's own
  // is disabled for this test.
  assert.deepEqual(outbound, []);
});

test("removes its signal handlers when the run ends", async () => {
  const ws = workspace(suite(CASES.read));
  const before = [
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
  ];
  await runTest(ws, []);
  assert.deepEqual(
    [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
    before
  );
});

test("test --help documents the local contract", async () => {
  const run = await captureProcessOutput(() =>
    main(["node", "mcpjam", "test", "--help"], { telemetry: telemetryDisabled })
  );
  assert.equal(run.result.exitCode, 0);
  for (const flag of [
    "--case",
    "--server",
    "--mcp-config",
    "--host",
    "--inference",
    "--reporter",
    "--out",
    "--max-steps",
  ]) {
    assert.match(run.stdout, new RegExp(flag));
  }
});
