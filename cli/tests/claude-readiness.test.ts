import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Command } from "commander";
import { startMockStreamableHttpServer } from "../../sdk/tests/mock-servers/index.js";
import {
  claudeReadinessExitCode,
  registerClaudeReadinessCommands,
} from "../src/commands/claude-readiness.js";

const CLI_DIR = process.cwd().endsWith(`${path.sep}cli`)
  ? process.cwd()
  : path.join(process.cwd(), "cli");
const requireFromCli = createRequire(path.join(CLI_DIR, "package.json"));
const TSX_CLI_PATH = requireFromCli.resolve("tsx/cli");
const CLI_ENTRY_PATH = path.join(CLI_DIR, "src", "index.ts");

/**
 * Run the CLI as a real process.
 *
 * A subprocess rather than an in-process `main()` call because the exit code is
 * the thing under test and `process.exitCode` is the channel it travels on —
 * reading it back in-process means reading a global the test runner also uses.
 */
async function runCli(
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [TSX_CLI_PATH, CLI_ENTRY_PATH, ...args],
      {
        cwd: CLI_DIR,
        env: {
          ...process.env,
          MCPJAM_CLI_DISABLE_BROWSER_OPEN: "1",
          MCPJAM_TELEMETRY_DISABLED: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === null) {
        reject(new Error(`CLI terminated by signal ${signal}`));
        return;
      }
      resolve({ exitCode: code, stdout, stderr });
    });
    child.stdin.end("");
  });
}

/** A profile that satisfies the schema, so the lane grades instead of stalling. */
function validSubmissionProfile(): unknown {
  return {
    name: "Acme Issues",
    tagline: "Search and file Acme issues from Claude",
    description:
      "Connects Claude to Acme's issue tracker so you can search, read and file issues without leaving the conversation.",
    categories: ["Developer tools"],
    slug: "acme-issues",
    documentationUrl: "https://acme.example.com/docs",
    privacyPolicyUrl: "https://acme.example.com/privacy",
    supportUrl: "https://acme.example.com/support",
    iconUrl: "https://acme.example.com/icon.png",
    declaredAuthMode: "authless",
    dataHandling: ["processes-user-data"],
    screenshots: [1, 2, 3].map((index) => ({
      url: `https://acme.example.com/shot-${index}.png`,
      mimeType: "image/png",
      widthPx: 1440,
      heightPx: 900,
      prompt: `Show me issue ${index}`,
    })),
    attestations: {
      ownsOrIsAuthorizedForService: true,
      accurateDataHandlingDisclosure: true,
      compliesWithUsagePolicies: true,
      noProhibitedContent: true,
      maintainsSecurityPractices: true,
      respondsToSecurityReports: true,
      keepsListingAccurate: true,
    },
  };
}

async function withProfileFile<T>(
  contents: string,
  fn: (profilePath: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-readiness-"));
  try {
    const profilePath = path.join(dir, "profile.json");
    await writeFile(profilePath, contents);
    return await fn(profilePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the exit code is keyed to the required-lane status, and only to that", () => {
  // Same ladder as `mcpjam protocol conformance`, so one CI configuration reads
  // both: 0 ready, 1 a requirement is unmet, 3 nothing was established.
  assert.equal(claudeReadinessExitCode({ status: "ready" }), 0);
  assert.equal(claudeReadinessExitCode({ status: "not-ready" }), 1);
  assert.equal(claudeReadinessExitCode({ status: "incomplete" }), 3);
});

test("registers `claude readiness` with the flags CI scripts are written against", () => {
  const program = new Command();
  registerClaudeReadinessCommands(program);

  const claude = program.commands.find(
    (command) => command.name() === "claude"
  );
  assert.ok(claude, "expected a `claude` command group");
  const readiness = claude.commands.find(
    (command) => command.name() === "readiness"
  );
  assert.ok(readiness, "expected `claude readiness`");

  const flags = readiness.options.map((option) => option.long);
  for (const flag of [
    "--url",
    "--access-token",
    "--credentials-file",
    "--header",
    "--timeout",
    "--submission-profile",
    "--claim-lazy-auth",
    "--claim-enterprise-auth",
    "--reporter",
  ]) {
    assert.ok(flags.includes(flag), `expected ${flag} to stay registered`);
  }
});

test("a plain-HTTP connector is not-ready, and the output says which requirement", async () => {
  const server = await startMockStreamableHttpServer();
  try {
    const run = await runCli([
      "claude",
      "readiness",
      "--url",
      server.url,
      "--format",
      "human",
    ]);

    // Exit 1, not 3: the run reached the server and established a violation.
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /Claude directory readiness: NOT-READY/);
    assert.match(run.stdout, /HTTPS/);
    // The verdict has to be attributable — a bare NOT-READY sends the reader
    // back to the docs to guess which of forty findings moved it.
    assert.match(run.stdout, /Unmet requirements \(\d+\):/);
    // Coverage travels beside every lane, so "no violations" can be told apart
    // from "nothing was evaluated".
    assert.match(run.stdout, /evaluated \d+ · not evaluated \d+/);
  } finally {
    await server.stop();
  }
});

test("without a submission profile the artifacts lane is incomplete and names the input", async () => {
  const server = await startMockStreamableHttpServer();
  try {
    const run = await runCli([
      "claude",
      "readiness",
      "--url",
      server.url,
      "--format",
      "json",
    ]);
    const result = JSON.parse(run.stdout) as {
      lanes: Array<{
        lane: string;
        status: string;
        coverage: { missingInputs: string[] };
      }>;
      context: { authMode: string; capabilities: string[] };
    };

    const submission = result.lanes.find(
      (lane) => lane.lane === "submission-artifacts"
    );
    assert.ok(submission);
    assert.equal(submission.status, "incomplete");
    assert.ok(
      submission.coverage.missingInputs.includes("submissionProfile"),
      "an incomplete lane must name what would close it"
    );

    // A run holding no token is `headless`, and the CLI records the
    // capabilities it actually has rather than claiming the hosted set.
    assert.equal(result.context.authMode, "headless");
    assert.deepEqual(result.context.capabilities, ["dns", "raw-origin"]);
  } finally {
    await server.stop();
  }
});

test("a valid submission profile closes the artifacts lane's missing input", async () => {
  const server = await startMockStreamableHttpServer();
  try {
    const run = await withProfileFile(
      JSON.stringify(validSubmissionProfile()),
      (profilePath) =>
        runCli([
          "claude",
          "readiness",
          "--url",
          server.url,
          "--submission-profile",
          profilePath,
          "--format",
          "json",
        ])
    );
    const result = JSON.parse(run.stdout) as {
      lanes: Array<{
        lane: string;
        status: string;
        coverage: { evaluated: number; missingInputs: string[] };
      }>;
    };

    const submission = result.lanes.find(
      (lane) => lane.lane === "submission-artifacts"
    );
    assert.ok(submission);
    assert.ok(
      !submission.coverage.missingInputs.includes("submissionProfile"),
      "supplying the profile must stop the lane asking for it"
    );
    assert.ok(submission.coverage.evaluated > 0);
    assert.notEqual(submission.status, "incomplete");
  } finally {
    await server.stop();
  }
});

test("a schema-invalid profile becomes findings that name the bad fields", async () => {
  const server = await startMockStreamableHttpServer();
  try {
    // Valid JSON, wrong shape: the failure belongs in the lane, where it can
    // say which field is wrong, not at the CLI boundary where it would take the
    // whole run down with it.
    const run = await withProfileFile(
      JSON.stringify({ name: "" }),
      (profilePath) =>
        runCli([
          "claude",
          "readiness",
          "--url",
          server.url,
          "--submission-profile",
          profilePath,
          "--format",
          "json",
        ])
    );

    assert.notEqual(run.exitCode, 2, "a bad profile is not a usage error");
    const result = JSON.parse(run.stdout) as {
      findings: Array<{
        lane: string;
        status: string;
        notEvaluatedReason?: string;
        details?: { issues?: string[] };
      }>;
    };
    const submission = result.findings.filter(
      (finding) => finding.lane === "submission-artifacts"
    );
    assert.ok(submission.length > 0);

    // NOT `violated`: an unparseable profile does not tell us the screenshots
    // are wrong, it tells us we could not look. What it must not do is read
    // like "you supplied nothing" — the caller did the work and got it wrong,
    // and the reason plus the issue list are what say so.
    assert.ok(
      submission.every((finding) => finding.status === "not-evaluated"),
      "a malformed profile cannot make a requirement fail"
    );
    const withIssues = submission.filter(
      (finding) => (finding.details?.issues?.length ?? 0) > 0
    );
    assert.ok(withIssues.length > 0, "the validation issues have to travel");
    assert.match(
      withIssues[0].notEvaluatedReason ?? "",
      /did not validate/,
      "the reason must distinguish a malformed profile from a missing one"
    );
    assert.ok(
      withIssues[0].details?.issues?.some((issue) => issue.startsWith("name")),
      "the issues have to name the field"
    );
  } finally {
    await server.stop();
  }
});

test("an unreadable --submission-profile is a usage error", async () => {
  const run = await runCli([
    "claude",
    "readiness",
    "--url",
    "https://example.invalid/mcp",
    "--submission-profile",
    path.join(tmpdir(), "does-not-exist-claude-readiness.json"),
  ]);
  assert.equal(run.exitCode, 2);
  assert.match(`${run.stdout}${run.stderr}`, /submission-profile/);
});

test("rejects --format junit-xml the way every other conformance command does", async () => {
  // `--format` chooses how a human or a script reads the result; `--reporter`
  // chooses a CI file format. Accepting a reporter name as a format here would
  // make this the one command where the two are interchangeable.
  const run = await runCli([
    "--format",
    "junit-xml",
    "claude",
    "readiness",
    "--url",
    "https://example.invalid/mcp",
  ]);
  assert.equal(run.exitCode, 2);
  assert.match(`${run.stdout}${run.stderr}`, /--reporter junit-xml/);
});

test("an empty --submission-profile is a usage error, not a silent skip", async () => {
  // Truthiness made `--submission-profile ""` report "no profile supplied",
  // which reads as our limitation rather than the caller's typo.
  const run = await runCli([
    "claude",
    "readiness",
    "--url",
    "https://example.invalid/mcp",
    "--submission-profile",
    "",
  ]);
  assert.equal(run.exitCode, 2);
  assert.match(`${run.stdout}${run.stderr}`, /submission-profile/);
});

test("the JUnit reporter carries advisories as properties, never as failures", async () => {
  const server = await startMockStreamableHttpServer();
  try {
    const run = await runCli([
      "claude",
      "readiness",
      "--url",
      server.url,
      "--reporter",
      "junit-xml",
    ]);

    assert.match(run.stdout, /<testsuites\b/);
    // The whole point of the separation: a heuristic or a recommendation must
    // never appear as a failed testcase, or a CI job goes red on an opinion,
    // someone appends `|| true`, and the real findings stop being read too.
    assert.match(run.stdout, /name="mcpjam\.advisor(y|ies)/);
    for (const advisoryClass of [
      "recommended",
      "heuristic",
      "manual-review",
      "experimental-feature",
    ]) {
      assert.ok(
        !new RegExp(`<failure[^>]*${advisoryClass}`).test(run.stdout),
        `${advisoryClass} findings must not become failures`
      );
    }
    // The reporter must still be able to fail: the HTTPS blocker is a real one.
    assert.match(run.stdout, /<failure\b/);
  } finally {
    await server.stop();
  }
});

test("a target nothing answers on is incomplete (3), not a violation (1)", async () => {
  // Nothing on this host resolves, so no lane can establish anything. The
  // distinction is the reason exit 3 exists: "we never reached it" and "it
  // broke a rule" send the reader to completely different places.
  const run = await runCli([
    "claude",
    "readiness",
    "--url",
    "https://connector.invalid/mcp",
    "--timeout",
    "3000",
    "--format",
    "json",
  ]);

  assert.equal(run.exitCode, 3);
  const result = JSON.parse(run.stdout) as {
    status: string;
    findings: Array<{ class: string; status: string }>;
  };
  assert.equal(result.status, "incomplete");
  assert.ok(
    !result.findings.some(
      (finding) =>
        finding.status === "violated" &&
        (finding.class === "required" || finding.class === "runtime-blocker")
    ),
    "an unreachable host must not be reported as breaking a requirement"
  );
});
