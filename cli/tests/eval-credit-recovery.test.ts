/**
 * `eval status` on a run MCPJam credits stopped: the step the refusal named,
 * read from the trial's structured `infraError.recovery`, as a `Recovery:`
 * line in human output and as `creditRecovery` in JSON. The refusals are the
 * shared corpus the SDK and Inspector parity tests read.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatCreditRecovery, parseCreditRecovery } from "@mcpjam/sdk";
import { main } from "../src/index.js";
import { captureProcessOutput, telemetryDisabled } from "./support/cli-run.js";

type CreditRefusalFixture = {
  __name: string;
  body: Record<string, unknown> & { code: string };
  expectedRecovery: string | null;
  expectedUrl: string | null;
};

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../sdk/tests/fixtures/credit-refusal-fixtures.json",
        import.meta.url
      )
    ),
    "utf8"
  )
) as { cases: CreditRefusalFixture[] };

async function startRunFixture(
  fixture: CreditRefusalFixture
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const iteration = {
    id: "iter-1",
    testCaseId: "case-1",
    title: "Search",
    iterationNumber: 1,
    status: "failed",
    result: "failed",
    actualToolCalls: [],
    expectedToolCalls: [],
    error: fixture.body.error,
    infraError: {
      class: "account_limit",
      layer: "platform",
      retryable: false,
      code: fixture.body.code,
      ...(fixture.body.recovery ? { recovery: fixture.body.recovery } : {}),
    },
  };
  const server: Server = createServer((req, res) => {
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
    if (url.pathname === "/api/v1/projects/proj-alpha/eval-runs/run-credit") {
      res.end(
        JSON.stringify({
          id: "run-credit",
          suiteId: "suite-1",
          runNumber: 7,
          status: "failed",
          result: "failed",
          summary: { total: 1, passed: 0, failed: 1, passRate: 0 },
          source: "api",
          notes: "Out of MCPJam credits.",
          createdAt: 1,
          completedAt: 2,
          judges: {},
        })
      );
      return;
    }
    if (
      url.pathname ===
      "/api/v1/projects/proj-alpha/eval-runs/run-credit/iterations"
    ) {
      res.end(JSON.stringify({ items: [iteration] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: "NOT_FOUND", message: "not here" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

const statusArgv = (baseUrl: string, format: "human" | "json") => [
  "node",
  "mcpjam",
  "cloud",
  "eval",
  "status",
  "--project",
  "proj-alpha",
  "--run",
  "run-credit",
  "--api-key",
  "sk_test",
  "--api-url",
  baseUrl,
  "--format",
  format,
];

for (const fixture of corpus.cases) {
  test(`eval status names the recovery for ${fixture.__name}`, async () => {
    const server = await startRunFixture(fixture);
    try {
      // A person-must-act recovery (anything but `wait`) blocks the run: status
      // exits 6 and prints a resume command. A `wait` recovery, or none, exits 0.
      const parsed = fixture.body.recovery
        ? parseCreditRecovery(fixture.body.recovery)
        : undefined;
      const blocked = parsed !== undefined && parsed.action !== "wait";
      const expectedExit = blocked ? 6 : 0;
      const human = await captureProcessOutput(() =>
        main(statusArgv(server.baseUrl, "human"), {
          telemetry: telemetryDisabled,
        })
      );
      assert.equal(human.result.exitCode, expectedExit, human.stderr);
      const json = await captureProcessOutput(() =>
        main(statusArgv(server.baseUrl, "json"), {
          telemetry: telemetryDisabled,
        })
      );
      assert.equal(json.result.exitCode, expectedExit);
      const document = JSON.parse(json.stdout.trim());

      if (fixture.expectedRecovery === null) {
        assert.doesNotMatch(human.stdout, /Recovery:/);
        assert.equal(document.creditRecovery, undefined);
        assert.equal(document.resumeCommand, undefined);
        return;
      }
      assert.ok(
        human.stdout.includes(`Recovery: ${fixture.expectedRecovery}\n`),
        human.stdout
      );
      assert.ok(human.stdout.includes(fixture.expectedUrl!));
      // The field, not its rendering: the human line is the only prose copy.
      assert.doesNotMatch(human.stdout, /"creditRecovery"/);
      assert.deepEqual(
        document.creditRecovery,
        parseCreditRecovery(fixture.body.recovery)
      );
      assert.equal(
        formatCreditRecovery(document.creditRecovery),
        fixture.expectedRecovery
      );
      if (blocked) {
        // One resume command, reconstructed from the run record (suite +
        // project + this run as the source), in both surfaces.
        assert.match(
          human.stdout,
          /Resume: mcpjam cloud eval run .*--resume --resume-from run-credit/
        );
        assert.ok(
          typeof document.resumeCommand === "string" &&
            document.resumeCommand.includes("--resume-from run-credit"),
          document.resumeCommand
        );
      } else {
        assert.doesNotMatch(human.stdout, /Resume:/);
        assert.equal(document.resumeCommand, undefined);
      }
    } finally {
      await server.close();
    }
  });
}
