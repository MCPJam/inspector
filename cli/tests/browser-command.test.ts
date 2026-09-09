import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "./support/task-cli-harness.js";

/** A state file per run, so these never touch a developer's real consent. */
async function stateFile(
  contents: Record<string, unknown> = { version: 1 },
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-browser-cli-"));
  const file = path.join(dir, "browser.json");
  await writeFile(file, JSON.stringify(contents));
  return file;
}

function env(file: string): NodeJS.ProcessEnv {
  // MCPJAM_LOCAL_CONSENT is cleared explicitly: `consentOf` reads it BEFORE the
  // stored consent, so a developer who happens to export one would have these
  // tests reach a real Inspector instead of failing the way they assert.
  return {
    ...process.env,
    MCPJAM_LOCAL_CONSENT: "",
    MCPJAM_BROWSER_STATE_FILE: file,
  };
}

test("browser commands are registered and documented", async () => {
  const result = await runCli(["browser", "--help"]);
  assert.equal(result.exitCode, 0);
  for (const verb of [
    "open",
    "observe",
    "act",
    "navigate",
    "note",
    "trace",
    "close",
    "consent",
    "invoke",
    "back",
    "forward",
    "reload",
  ]) {
    assert.match(result.stdout, new RegExp(`\\b${verb}\\b`));
  }
});

test("the CLI never grants its own consent — it says where to get one", async () => {
  // The Inspector's consent screen is where a person authorizes the agent
  // browser. A CLI that could mint the capability would be that screen's own
  // bypass, so a missing one is an error that points at the UI.
  const file = await stateFile();
  const result = await runCli(
    ["--format", "json", "browser", "open", "--project", "p"],
    undefined,
    { env: env(file) },
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr + result.stdout, /has not been authorized/i);
  assert.match(result.stderr + result.stdout, /mcpjam browser consent/);
});

test("`browser consent` stores what a person granted in the UI", async () => {
  const file = await stateFile();
  const result = await runCli(
    ["--format", "json", "browser", "consent", "--token", "cap-xyz"],
    undefined,
    { env: env(file) },
  );
  assert.equal(result.exitCode, 0);
  const { readBrowserState } =
    await import("../src/lib/browser-session-store.js");
  assert.equal(readBrowserState(file).consent, "cap-xyz");
});

test("a command with no open session says so instead of guessing one", async () => {
  const file = await stateFile({ version: 1, consent: "cap" });
  const result = await runCli(
    ["--format", "json", "browser", "observe", "--project", "p"],
    undefined,
    { env: env(file) },
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr + result.stdout, /No open browser session/i);
  assert.match(result.stderr + result.stdout, /browser open/);
});

test("two targets on one act is a usage error, not a silent pick", async () => {
  // Picking one silently would aim the click somewhere the caller did not ask
  // for, which looks exactly like a click that missed.
  const file = await stateFile({
    version: 1,
    consent: "cap",
    sessions: { p: "bs_00000000-0000-4000-8000-000000000000" },
  });
  const result = await runCli(
    [
      "--format",
      "json",
      "browser",
      "act",
      "--project",
      "p",
      "--verb",
      "click",
      "--ref",
      "e1",
      "--selector",
      "#save",
    ],
    undefined,
    { env: env(file) },
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr + result.stdout, /Give one target/i);
});

test("coordinates must both be numbers", async () => {
  const file = await stateFile({
    version: 1,
    consent: "cap",
    sessions: { p: "bs_00000000-0000-4000-8000-000000000000" },
  });
  const result = await runCli(
    [
      "--format",
      "json",
      "browser",
      "act",
      "--project",
      "p",
      "--verb",
      "click",
      "--x",
      "nope",
      "--y",
      "5",
    ],
    undefined,
    { env: env(file) },
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(
    result.stderr + result.stdout,
    /--x and --y must both be numbers/,
  );
});

test("an executed-but-failed command is not reported as a success", async () => {
  // `executed` says the command RAN; `ok` says whether it succeeded. A click
  // that found no button ran fine and failed, and reporting that as success is
  // how a script carries on as though the form were submitted.
  const { emitForTests } = await import("../src/commands/browser.js");
  const failed = emitForTests({ status: "executed", ok: false });
  assert.equal(failed.success, false);
  const ran = emitForTests({ status: "executed", ok: true });
  assert.equal(ran.success, true);
  // A refusal and an unknown outcome are not successes either.
  assert.equal(emitForTests({ status: "refused" }).success, false);
  assert.equal(emitForTests({ status: "unknown" }).success, false);
});

test("the normalized success wins over anything in the payload", async () => {
  // Spread-then-assign, not the other way round: a payload carrying its own
  // `success` would otherwise override the normalization, and the field a
  // script branches on would come from the wire rather than the outcome rules.
  const { emitForTests } = await import("../src/commands/browser.js");
  assert.equal(
    emitForTests({ status: "executed", ok: false, success: true }).success,
    false,
  );
  assert.equal(
    emitForTests({ status: "refused", success: true }).success,
    false,
  );
});

test("a project name that is an inherited property is not a session", async () => {
  // A parsed JSON object still inherits from Object.prototype, so
  // `--project toString` resolved to a function and was handed on as a session.
  const file = await stateFile({ version: 1, consent: "cap", sessions: {} });
  const result = await runCli(
    ["--format", "json", "browser", "observe", "--project", "toString"],
    undefined,
    { env: env(file) },
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr + result.stdout, /No open browser session/i);
});

test("the consent capability is never sent to a cleartext remote Inspector", async () => {
  // It authorizes driving a browser signed into the user's accounts; in
  // cleartext to a remote host it is on the wire for anyone on the path.
  const file = await stateFile({
    version: 1,
    consent: "cap",
    sessions: { p: "bs_00000000-0000-4000-8000-000000000000" },
  });
  const remote = await runCli(
    [
      "--format",
      "json",
      "browser",
      "observe",
      "--project",
      "p",
      "--inspector-url",
      "http://inspector.example.com",
    ],
    undefined,
    { env: env(file) },
  );
  assert.notEqual(remote.exitCode, 0);
  assert.match(remote.stderr + remote.stdout, /cleartext/i);
  // …but http://localhost is how everybody actually runs it.
  const local = await runCli(
    [
      "--format",
      "json",
      "browser",
      "observe",
      "--project",
      "p",
      "--inspector-url",
      "http://localhost:6274",
    ],
    undefined,
    { env: env(file) },
  );
  assert.doesNotMatch(local.stderr + local.stdout, /cleartext/i);
});

test("a loopback URL still has to be http or https", async () => {
  // The exception is for cleartext HTTP on localhost, not for any scheme at
  // all: `ws://localhost` is not an Inspector this can talk to, and failing
  // inside a fetch says less than failing on the argument that was typed.
  const file = await stateFile({
    version: 1,
    consent: "cap",
    sessions: { p: "bs_00000000-0000-4000-8000-000000000000" },
  });
  for (const url of ["ws://localhost:6274", "ftp://localhost"]) {
    const result = await runCli(
      [
        "--format",
        "json",
        "browser",
        "observe",
        "--project",
        "p",
        "--inspector-url",
        url,
      ],
      undefined,
      { env: env(file) },
    );
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr + result.stdout, /cleartext/i);
  }
});

test("a misspelled --profile is a usage error, not the real browser", async () => {
  // `--profile ephermal` asked for a throwaway context; opening the project's
  // logged-in Chromium instead is the mix-up this surface exists to prevent.
  const file = await stateFile({ version: 1, consent: "cap" });
  const result = await runCli(
    [
      "--format",
      "json",
      "browser",
      "open",
      "--project",
      "p",
      "--profile",
      "ephermal",
    ],
    undefined,
    { env: env(file) },
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr + result.stdout, /Unknown --profile/);
});

test("a REFUSED command is a structured result, not a thrown error", async () => {
  // The door answers a refusal with 403 and an unknown outcome with 502. If the
  // transport throws those away, `refused` (nothing ran, retry is safe) and
  // `unknown` (it may have run, do NOT retry) become one generic failure — and
  // a script that retries on error re-submits a command that already happened.
  const { isContractResultForTests } =
    await import("../src/commands/browser.js");
  // THE SHAPE THE DOOR ACTUALLY SENDS. `/local-browser/command` answers
  // `c.json(ran.result, ran.status)`, so the contract result is the whole body
  // — not nested under `result`. Asserting the nested shape is what let this
  // predicate ship inert: it agreed with itself and never with the server.
  assert.equal(
    isContractResultForTests({ status: "refused", commandId: "c1" }),
    true,
  );
  assert.equal(
    isContractResultForTests({ status: "unknown", commandId: "c1" }),
    true,
  );
  assert.equal(
    isContractResultForTests({ status: "executed", ok: false }),
    true,
  );
  // …and a genuine failure is NOT, so it still throws and stays loud.
  assert.equal(
    isContractResultForTests({ error: "Local computer consent is required" }),
    false,
  );
  assert.equal(isContractResultForTests({ status: "wat" }), false);
  // The old nested shape is not a contract result either — nothing sends it.
  assert.equal(
    isContractResultForTests({ result: { status: "refused" } }),
    false,
  );
  assert.equal(isContractResultForTests(null), false);
  assert.equal(isContractResultForTests("refused"), false);
});

test("act and navigate default to folding in an a11y observation", async () => {
  // One round trip, one ledger row, and refs for the next act — a screenshot
  // carries none.
  for (const verb of ["act", "navigate"]) {
    const help = await runCli(["browser", verb, "--help"]);
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /--observe-after/);
    assert.match(help.stdout, /default: "a11y"/);
  }
});

test("act and navigate expose an idempotency key for a safe retry", async () => {
  for (const verb of ["act", "navigate"]) {
    const help = await runCli(["browser", verb, "--help"]);
    assert.match(help.stdout, /--command-id/);
  }
});

test("cloud uses bearer auth and deployment-scoped session storage without local consent", async () => {
  const { createServer } = await import("node:http");
  const { readFile } = await import("node:fs/promises");
  const calls: Array<{
    url: string | undefined;
    auth: string | undefined;
    consent: string | string[] | undefined;
    body: Record<string, unknown>;
  }> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({
      url: req.url,
      auth: req.headers.authorization,
      consent: req.headers["x-mcpjam-local-consent"],
      body: JSON.parse(raw),
    });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url?.endsWith("/session")
          ? { session: { sessionId: "cloud-session" } }
          : req.url?.endsWith("/artifact")
            ? { screenshot: "aGVsbG8=" }
            : {
                status: "executed",
                ok: true,
                commandId: "cmd",
                page: {
                  artifacts: {
                    screenshot: { id: "cmd", mediaType: "image/jpeg" },
                  },
                },
              },
      ),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const apiUrl = `http://127.0.0.1:${
    (server.address() as { port: number }).port
  }/api/v1`;
  const file = await stateFile({
    version: 1,
    consent: "NEVER-SEND",
    sessions: { p: "local-session" },
  });
  const flags = [
    "--cloud",
    "--api-url",
    apiUrl,
    "--api-key",
    "sk_test",
    "--project",
    "p",
  ];
  try {
    const opened = await runCli(
      ["--format", "json", "browser", "open", ...flags],
      undefined,
      { env: env(file) },
    );
    assert.equal(opened.exitCode, 0, opened.stderr);
    const observed = await runCli(
      [
        "--format",
        "json",
        "browser",
        "observe",
        "--mode",
        "screenshot",
        ...flags,
      ],
      undefined,
      { env: env(file) },
    );
    assert.equal(observed.exitCode, 0, observed.stderr);
    const invoked = await runCli(
      [
        "--format",
        "json",
        "browser",
        "invoke",
        "getAvailability",
        "--input",
        '{"day":"Monday"}',
        ...flags,
      ],
      undefined,
      { env: env(file) },
    );
    assert.equal(invoked.exitCode, 0, invoked.stderr);
    assert.deepEqual(calls[3].body.command, {
      op: "invoke_page_tool",
      toolKey: "getAvailability",
      input: { day: "Monday" },
    });
    assert.deepEqual(
      calls.map((c) => c.url),
      [
        "/api/v1/browser-sessions/session",
        "/api/v1/browser-sessions/command",
        "/api/v1/browser-sessions/artifact",
        "/api/v1/browser-sessions/command",
      ],
    );
    assert.ok(
      calls.every(
        (c) => c.auth === "Bearer sk_test" && c.consent === undefined,
      ),
    );
    assert.equal(calls[1].body.sessionId, "cloud-session");
    const state = JSON.parse(await readFile(file, "utf8"));
    assert.equal(state.sessions.p, "local-session");
    assert.equal(state.sessions[`cloud:${apiUrl}:p`], "cloud-session");
    const output = JSON.parse(observed.stdout);
    assert.equal(await readFile(output.screenshotPath, "utf8"), "hello");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
