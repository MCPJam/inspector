// Record the app-server stream fixtures the adapter's translator tests replay.
//
//   node probe/record-fixtures.mjs --codex <path-to-codex> [--out <dir>]
//
// Each scenario drives the real binary against the scripted fake Responses API
// and writes the SERVER-TO-CLIENT frames, one JSON object per line, in arrival
// order. Server requests (approvals) are kept in the stream: the tests route
// them to the approval controller exactly as the bridge does, so the recorded
// ORDER — approval before `item/started` — is part of what the fixture pins.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeResponsesServer } from "./fake-responses-server.mjs";
import { spawnAppServer } from "./app-server-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const CODEX = arg("codex", "codex");
const OUT = arg(
  "out",
  join(
    HERE,
    "..",
    "..",
    "mcpjam-inspector",
    "server",
    "utils",
    "harness",
    "codex-appserver",
    "__tests__",
    "fixtures"
  )
);

/** Approval answers, by scenario. */
const SCENARIOS = {
  "command-approved": {
    prompt: "Create a file called probe.txt containing hi.",
    approvalPolicy: "untrusted",
    sandbox: "workspace-write",
    decision: "accept",
    script: [
      {
        reasoning: "The user wants a file. I will write it with the shell.",
        functionCalls: [
          { name: "exec_command", arguments: { cmd: "echo hi > probe.txt" } },
        ],
      },
      { text: "Created probe.txt for you." },
    ],
  },
  "command-declined": {
    prompt: "Create a file called denied.txt.",
    approvalPolicy: "untrusted",
    sandbox: "workspace-write",
    decision: "decline",
    script: [
      {
        functionCalls: [
          { name: "exec_command", arguments: { cmd: "echo hi > denied.txt" } },
        ],
      },
      { text: "I was not allowed to create it." },
    ],
  },
  "text-and-reasoning": {
    prompt: "Explain yourself.",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    decision: "accept",
    script: [
      {
        reasoning:
          "First I consider the question. Then I consider it some more, at length, so the summary streams in several deltas.",
        text: "Here is a considered answer that arrives as a stream of text deltas rather than in one piece.",
      },
    ],
  },
  "file-change": {
    prompt: "Patch the file.",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    decision: "accept",
    script: [
      {
        functionCalls: [
          {
            name: "exec_command",
            arguments: {
              cmd: "mkdir -p sub && printf 'one\\ntwo\\n' > sub/patched.txt",
            },
          },
        ],
      },
      { text: "Patched." },
    ],
  },
};

function writeCodexHome(baseUrl) {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  writeFileSync(
    join(home, "config.toml"),
    [
      'model = "gpt-5-nano"',
      'model_provider = "probe"',
      'model_reasoning_summary = "detailed"',
      "",
      "[model_providers.probe]",
      'name = "probe"',
      `base_url = ${JSON.stringify(`${baseUrl}/v1`)}`,
      'env_key = "PROBE_API_KEY"',
      'wire_api = "responses"',
    ].join("\n") + "\n"
  );
  return home;
}

mkdirSync(OUT, { recursive: true });
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  const fake = createFakeResponsesServer({
    script: scenario.script,
    strictToolNames: false,
  });
  const baseUrl = await fake.listen();
  const home = writeCodexHome(baseUrl);
  const cwd = mkdtempSync(join(tmpdir(), "codex-cwd-"));
  const frames = [];
  const client = spawnAppServer({
    codexBin: CODEX,
    codexHome: home,
    cwd,
    env: { PROBE_API_KEY: "probe-placeholder", RUST_LOG: "error" },
    onNotification: (frame) => frames.push(frame),
    onServerRequest: async (frame) => {
      frames.push(frame);
      return { decision: scenario.decision };
    },
    onStderr: () => {},
  });
  // try/finally: a rejection in the handshake or the turn used to skip BOTH
  // cleanups, leaving the codex child and the listening fake server behind and
  // the command hung.
  try {
    await client.request("initialize", {
      clientInfo: { name: "mcpjam-fixture-recorder", version: "0.0.0" },
    });
    client.notify("initialized", {});
    const thread = await client.request("thread/start", {
      cwd,
      approvalPolicy: scenario.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: scenario.sandbox,
    });
    const done = new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (frames.some((f) => f.method === "turn/completed")) {
          clearInterval(timer);
          clearTimeout(deadline);
          resolve();
        }
      }, 100);
      // REJECTS. Resolving on timeout wrote a partial stream over a good
      // fixture and exited 0 — a truncated recording that every translator test
      // would then treat as the protocol's real shape.
      const deadline = setTimeout(() => {
        clearInterval(timer);
        reject(
          new Error(`timed out waiting for turn/completed in "${name}"`)
        );
      }, 60_000);
    });
    await client.request("turn/start", {
      threadId: thread.thread.id,
      input: [{ type: "text", text: scenario.prompt }],
    });
    await done;
  } finally {
    await client.close();
    await fake.close();
  }

  const path = join(OUT, `${name}.jsonl`);
  writeFileSync(path, `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
  process.stdout.write(
    `${name}: ${frames.length} frames -> ${path}\n  methods: ${[
      ...new Set(frames.map((f) => f.method)),
    ].join(", ")}\n`
  );
}
