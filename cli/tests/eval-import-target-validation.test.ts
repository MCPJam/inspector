/**
 * Live validation of the servers a suite file TARGETS, independent of whether
 * any case makes a deterministic tool call.
 *
 * A prompt-only suite naming a server the project lacks used to validate clean,
 * because the check returned before resolving targets when there was nothing
 * deterministic to look up. These tests pin the target check on its own: a
 * missing or disabled server is a finding, a failed lookup is a command error,
 * and none of it costs a tool listing.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { main } from "../src/index.js";
import {
  captureProcessOutput,
  runArgv,
  startFixture,
  telemetryDisabled,
  validateArgv,
  withSuiteFile,
  type ValidateEnvelope,
} from "./support/eval-import-fixture.js";

function promptOnly(targetBlock: string): string {
  return `schemaVersion: "1"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_billing
  name: Billing smoke
target:
${targetBlock}defaults:
  model: anthropic/claude-sonnet-4-6
  repetitions: 1
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
}

const SERVERS_BILLING = "  servers:\n    - name: billing\n";
const SERVERS_GHOST = "  servers:\n    - name: ghost\n";

/** `billing` resolves; `ghost` does not, and a deterministic call names it. */
const MIXED_WITH_UNKNOWN_SERVER = `schemaVersion: "1"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_billing
  name: Billing smoke
target:
  servers:
    - name: billing
    - name: ghost
defaults:
  model: anthropic/claude-sonnet-4-6
  repetitions: 1
  passThreshold: 0.8
  validity: {}
cases:
  - id: c_render
    title: Renders the refund widget
    steps:
      - id: step-1
        kind: toolCall
        serverName: billing
        toolName: render_refund
        arguments: {}
  - id: c_ghost
    title: Calls a tool on a server the project lacks
    steps:
      - id: step-1
        kind: toolCall
        serverName: ghost
        toolName: haunt
        arguments: {}
`;

async function validate(
  baseUrl: string,
  contents: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return withSuiteFile(contents, async (file) => {
    const run = await captureProcessOutput(() =>
      main(
        validateArgv(
          file,
          "--project",
          "Alpha",
          "--api-key",
          "sk_test",
          "--api-url",
          baseUrl
        ),
        { telemetry: telemetryDisabled }
      )
    );
    return {
      exitCode: run.result.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
    };
  });
}

describe("eval validate --project checks the targeted servers", () => {
  test("a prompt-only suite on an existing server is valid without listing tools", async () => {
    const fixture = await startFixture();
    try {
      const run = await validate(fixture.baseUrl, promptOnly(SERVERS_BILLING));
      assert.equal(run.exitCode, 0, run.stderr);
      const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
      assert.equal(envelope.valid, true);
      assert.deepEqual(envelope.projectValidation?.targets, [
        "the file's target.servers",
      ]);
      assert.deepEqual(envelope.projectValidation?.findings, []);
      assert.ok(
        fixture.requests.includes("GET /api/v1/projects/proj-alpha/servers")
      );
      assert.deepEqual(fixture.toolListings, []);
    } finally {
      await fixture.close();
    }
  });

  test("a prompt-only suite naming a missing server is invalid", async () => {
    const fixture = await startFixture();
    try {
      const run = await validate(fixture.baseUrl, promptOnly(SERVERS_GHOST));
      assert.equal(run.exitCode, 1, run.stderr);
      const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
      assert.equal(envelope.valid, false);
      assert.equal(envelope.projectValidation?.valid, false);
      assert.deepEqual(envelope.projectValidation?.findings, [
        {
          code: "SERVER_UNRESOLVED",
          path: ["target", "servers", 0],
          pointer: "target.servers[0]",
          server: "ghost",
          targetLabel: "the file's target.servers",
          message:
            'Server "ghost" in the file\'s target.servers is not a server in this project.',
        },
      ]);
      assert.deepEqual(fixture.toolListings, []);
    } finally {
      await fixture.close();
    }
  });

  test("a prompt-only suite on a disabled server is invalid", async () => {
    const fixture = await startFixture({ disabledServers: ["billing"] });
    try {
      const run = await validate(fixture.baseUrl, promptOnly(SERVERS_BILLING));
      assert.equal(run.exitCode, 1, run.stderr);
      const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
      assert.equal(envelope.valid, false);
      const [found] = envelope.projectValidation!.findings;
      assert.equal(envelope.projectValidation!.findings.length, 1);
      assert.equal(found.code, "SERVER_DISABLED");
      assert.equal(found.server, "billing");
      assert.equal(found.serverId, "srv_billing");
      assert.deepEqual(fixture.toolListings, []);
    } finally {
      await fixture.close();
    }
  });

  test("a disabled server in an environment's resolved set is reported", async () => {
    const fixture = await startFixture({
      environments: { prod: ["billing"] },
      disabledServers: ["billing"],
    });
    try {
      const run = await validate(
        fixture.baseUrl,
        promptOnly(`${SERVERS_BILLING}  environment: prod\n`)
      );
      assert.equal(run.exitCode, 1, run.stderr);
      const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
      const findings = envelope.projectValidation!.findings;
      assert.deepEqual(
        findings.map((found) => [found.code, found.targetLabel]),
        [["SERVER_DISABLED", "environment prod"]]
      );
    } finally {
      await fixture.close();
    }
  });

  test("a call on an unknown server is reported as the server, not as 'not part of the target'", async () => {
    const fixture = await startFixture();
    try {
      const run = await validate(fixture.baseUrl, MIXED_WITH_UNKNOWN_SERVER);
      assert.equal(run.exitCode, 1, run.stderr);
      const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
      const findings = envelope.projectValidation!.findings;
      assert.deepEqual(
        findings.map((found) => [found.code, found.pointer]),
        [["SERVER_UNRESOLVED", "target.servers[1]"]]
      );
      assert.doesNotMatch(run.stdout, /not part of/);
      // The resolvable server's call was still checked.
      assert.deepEqual(fixture.toolListings, ["srv_billing"]);
    } finally {
      await fixture.close();
    }
  });

  test("each file host is its own target, and only the broken one is reported", async () => {
    const fixture = await startFixture();
    try {
      const run = await validate(
        fixture.baseUrl,
        promptOnly(
          SERVERS_BILLING +
            "  hosts:\n" +
            "    - name: Claude Desktop\n      servers:\n        - name: billing\n" +
            "    - name: Cursor\n      servers:\n        - name: ghost\n"
        )
      );
      assert.equal(run.exitCode, 1, run.stderr);
      const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
      assert.ok(envelope.projectValidation, run.stdout);
      assert.deepEqual(envelope.projectValidation.targets, [
        "host Claude Desktop",
        "host Cursor",
      ]);
      const findings = envelope.projectValidation!.findings;
      assert.deepEqual(
        findings.map((found) => [found.code, found.pointer, found.targetLabel]),
        [["SERVER_UNRESOLVED", "target.hosts[1].servers[0]", "host Cursor"]]
      );
    } finally {
      await fixture.close();
    }
  });

  test("a failed server lookup is a command error, never a verdict", async () => {
    const fixture = await startFixture({ serversListStatus: 503 });
    try {
      const run = await validate(fixture.baseUrl, promptOnly(SERVERS_BILLING));
      assert.notEqual(run.exitCode, 0);
      assert.doesNotMatch(run.stdout, /"valid"/);
      assert.deepEqual(fixture.toolListings, []);
    } finally {
      await fixture.close();
    }
  });

  test("without --project a missing server reaches no network and stays valid", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(promptOnly(SERVERS_GHOST), async (file) => {
        const run = await captureProcessOutput(() =>
          main(validateArgv(file), { telemetry: telemetryDisabled })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
        assert.equal(envelope.valid, true);
        assert.equal(envelope.projectValidation, undefined);
        assert.deepEqual(fixture.requests, []);
      });
    } finally {
      await fixture.close();
    }
  });
});

describe("eval run --file refuses a broken target before it writes", () => {
  for (const [name, contents, options] of [
    ["missing", promptOnly(SERVERS_GHOST), {}],
    ["disabled", promptOnly(SERVERS_BILLING), { disabledServers: ["billing"] }],
  ] as const) {
    test(`a prompt-only suite on a ${name} server`, async () => {
      const fixture = await startFixture(options);
      try {
        await withSuiteFile(contents, async (file) => {
          const run = await captureProcessOutput(() =>
            main(runArgv(fixture.baseUrl, file), {
              telemetry: telemetryDisabled,
            })
          );
          assert.equal(run.result.exitCode, 2, run.stdout);
          assert.match(run.stdout + run.stderr, /IMPORT_TARGET_UNRESOLVED/);
          assert.deepEqual(fixture.fromFileBodies, []);
          assert.deepEqual(fixture.batchBodies, []);
          assert.deepEqual(fixture.runBodies, []);
          assert.deepEqual(fixture.toolListings, []);
        });
      } finally {
        await fixture.close();
      }
    });
  }
});
