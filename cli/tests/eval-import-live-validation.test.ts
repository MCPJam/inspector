/**
 * Live, project-aware validation of a suite file's deterministic tool
 * references — the check `eval validate --project` performs on request and
 * every `eval run --file` performs whether you ask for it or not.
 *
 * What is worth asserting here, over and above "the command ran":
 *
 *  - `eval validate` with NO `--project` still reaches no network. Driven below
 *    against a fixture that counts every request, so a client construction
 *    sneaking into the offline path fails the test instead of quietly working.
 *  - A refusal happens BEFORE the writes. The assertions are on the fixture's
 *    recorded bodies being EMPTY, not merely on a non-zero exit — a run that
 *    synced a suite and then refused would pass the weaker check while leaving
 *    the caller's project half-written.
 *  - A disabled imported case is PERSISTED with a rewritten claim rather than
 *    dropped. Deleting it would destroy the case's hosted history the moment
 *    somebody parks a converted test.
 *  - Multi-target is checked per target, never over the union. The union is the
 *    false negative this whole check exists to prevent.
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

// ── suite files ──────────────────────────────────────────────────────────────

/**
 * `c_render` calls a tool the fixture server exposes; `c_missing` calls one it
 * does not. Both are imported, and `c_missing` is DISABLED — the combination
 * that has to be persisted-but-rewritten rather than refused or dropped.
 */
const IMPORTED_WITH_TOOL_CALLS = `schemaVersion: "1"
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
    import:
      status: exact
      sourceCaseKey: upstream/refunds/render
      note: "1:1 with the upstream render assertion."
  - id: c_missing
    title: Renders a widget that no longer exists
    disabled: true
    steps:
      - id: step-1
        kind: toolCall
        serverName: billing
        toolName: render_gone
        arguments: {}
    import:
      status: exact
      sourceCaseKey: upstream/refunds/gone
      note: "1:1 with the upstream legacy render assertion."
provenance:
  sourceHash: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  sourceFormat: upstream-evals
  reportHash: 2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae
`;

/**
 * One case per approvable/unapprovable shape, all enabled and all resolving.
 *
 * Every reference here EXISTS on the fixture server, so nothing in this file
 * is refused for the unrelated reason — an approval test that failed because
 * of a missing tool would be green for the wrong reason.
 */
const APPROVAL_SUITE = `schemaVersion: "1"
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
  repetitions: 1
  passThreshold: 0.8
  validity: {}
cases:
  - id: c_approx
    title: Refuses to refund outside the window
    steps:
      - id: step-1
        kind: toolCall
        serverName: billing
        toolName: render_refund
        arguments: {}
    import:
      status: approximated
      sourceCaseKey: upstream/refunds/out-of-window
      note: Upstream asserted on a rendered string; mapped to the negative-case rule.
  - id: c_approx_two
    title: Also approximated
    steps:
      - id: step-1
        kind: toolCall
        serverName: billing
        toolName: issue_refund
        arguments: {}
    import:
      status: approximated
      note: Second approximation, so one reason can cover two approvals.
  - id: c_exact
    title: Renders the refund widget
    steps:
      - id: step-1
        kind: toolCall
        serverName: billing
        toolName: render_refund
        arguments: {}
    import:
      status: exact
      note: "1:1 with the upstream render assertion."
  - id: c_unsupported
    title: Replays a recorded browser session
    steps:
      - id: step-1
        kind: prompt
        prompt: Walk through the checkout flow.
    import:
      status: unsupported
      note: Upstream drove a real browser; no counterpart here.
  - id: c_native
    title: Authored here
    steps:
      - id: step-1
        kind: prompt
        prompt: Refund the duplicate charge on invoice 4471.
  - id: c_parked
    title: Parked approximation
    disabled: true
    steps:
      - id: step-1
        kind: prompt
        prompt: Reconcile the partial refund.
    import:
      status: approximated
      note: Parked while the upstream rubric is clarified.
provenance:
  sourceHash: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  sourceFormat: upstream-evals
  reportHash: 2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae
`;

/** The same missing tool, but on an ENABLED case: the launch must refuse. */
const IMPORTED_ENABLED_MISSING = IMPORTED_WITH_TOOL_CALLS.replace(
  "    disabled: true\n",
  ""
);

/** No import block anywhere, and the missing tool is on a disabled case. */
const NATIVE_WITH_TOOL_CALLS = `schemaVersion: "1"
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
  - id: c_missing
    title: Renders a widget that no longer exists
    disabled: true
    steps:
      - id: step-1
        kind: toolCall
        serverName: billing
        toolName: render_gone
        arguments: {}
`;

/** Prompt-only: nothing deterministic, so no tool listing to fetch. */
const PROMPT_ONLY = `schemaVersion: "1"
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

/**
 * The mention is in PROMPT TEXT and in an ASSERTION, never in a `toolCall`.
 * Neither is a deterministic reference, so neither may produce a finding.
 */
const MENTIONS_ONLY = `schemaVersion: "1"
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
  repetitions: 1
  passThreshold: 0.8
  validity: {}
cases:
  - id: c_hint
    title: Mentions a tool it does not deterministically call
    steps:
      - id: step-1
        kind: prompt
        prompt: Use render_gone to show the refund.
      - id: step-2
        kind: assert
        assertion:
          type: toolCalledWith
          toolName: render_gone
          args:
            args: {}
            argumentMatching: partial
`;

/**
 * Two enabled cases sharing one TITLE, which the suite contract permits — only
 * case ids must be unique.
 *
 * `c_new` comes FIRST in the file and its deterministic call does not resolve;
 * `c_old` comes second and resolves. Seed `c_old` as an existing hosted row and
 * the two orderings disagree: authored order makes `c_old` the last match for
 * the shared title, while the launcher sees `[...updates, ...creates]` and
 * makes `c_new` the last match. Resolving the title here rather than widening
 * would vouch for `c_old` and run `c_new`.
 */
const SHARED_TITLE_CREATE_AND_UPDATE = `schemaVersion: "1"
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
  repetitions: 1
  passThreshold: 0.8
  validity: {}
cases:
  - id: c_new
    title: Renders the refund widget
    steps:
      - id: step-1
        kind: toolCall
        serverName: billing
        toolName: render_gone
        arguments: {}
  - id: c_old
    title: Renders the refund widget
    steps:
      - id: step-1
        kind: toolCall
        serverName: billing
        toolName: render_refund
        arguments: {}
`;

// ── offline compatibility ────────────────────────────────────────────────────

describe("eval validate stays offline without --project", () => {
  test("no --project reaches no network and reports no projectValidation", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(IMPORTED_WITH_TOOL_CALLS, async (file) => {
        const run = await captureProcessOutput(() =>
          // Deliberately no --api-key and no --api-url: a client construction
          // sneaking into this path cannot even be configured, so it fails
          // here rather than working quietly on a machine that happens to be
          // logged in.
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

// ── the live check ───────────────────────────────────────────────────────────

describe("eval validate --project", () => {
  test("names the case, pointer and tool of a missing deterministic reference", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(IMPORTED_WITH_TOOL_CALLS, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            validateArgv(
              file,
              "--project",
              "Alpha",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl
            ),
            { telemetry: telemetryDisabled }
          )
        );
        // A completed live check with an unresolved reference is a VERDICT on
        // the file — the command's ordinary "judged invalid" exit, not the
        // "no verdict was reached" exit an unreadable file gets.
        assert.equal(run.result.exitCode, 1, run.stderr);
        const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
        assert.equal(envelope.valid, false);
        const live = envelope.projectValidation!;
        assert.equal(live.valid, false);
        assert.deepEqual(live.project, { id: "proj-alpha", name: "Alpha" });
        assert.equal(live.findings.length, 1);
        const [found] = live.findings;
        assert.equal(found.code, "TOOL_REFERENCE_UNRESOLVED");
        assert.equal(found.caseId, "c_missing");
        assert.equal(found.toolName, "render_gone");
        assert.equal(found.serverName, "billing");
        assert.equal(found.pointer, "cases[1].steps[0].toolName");
        // The two flags that decide what a RUN does with this case.
        assert.equal(found.disabled, true);
        assert.equal(found.imported, true);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a file whose references all resolve stays valid", async () => {
    const fixture = await startFixture({
      toolsByServer: { billing: ["render_refund", "render_gone"] },
    });
    try {
      await withSuiteFile(IMPORTED_WITH_TOOL_CALLS, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            validateArgv(
              file,
              "--project",
              "Alpha",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
        assert.equal(envelope.projectValidation?.valid, true);
        assert.deepEqual(envelope.projectValidation?.findings, []);
      });
    } finally {
      await fixture.close();
    }
  });

  // MCP 2026-07-28 `server/utilities/pagination`: "an empty string is a valid
  // cursor and thus MUST NOT be treated as the end of results". Stopping on
  // one here does not merely truncate a list — the set this walk builds is
  // what decides "this tool name does not exist", so a short walk REJECTS a
  // perfectly valid suite at import.
  test("follows an empty-string cursor rather than reporting page two's tool as missing", async () => {
    const fixture = await startFixture({
      paginatedTools: {
        server: "billing",
        pages: [["render_refund"], ["render_gone"]],
        // Page one's cursor is the empty string. `render_gone` — which the
        // file references — is only reachable by following it.
        cursors: ["", undefined],
      },
    });
    try {
      await withSuiteFile(IMPORTED_WITH_TOOL_CALLS, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            validateArgv(
              file,
              "--project",
              "Alpha",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl
            ),
            { telemetry: telemetryDisabled }
          )
        );
        // Validates CLEAN: the walk read both pages, so neither referenced
        // tool is reported as nonexistent.
        assert.equal(run.result.exitCode, 0, run.stderr);
        const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
        assert.equal(envelope.projectValidation?.valid, true);
        assert.deepEqual(envelope.projectValidation?.findings, []);
        // And the second request genuinely carried `cursor: ""` — a truthiness
        // forward would have dropped it and silently re-read page one.
        assert.deepEqual(fixture.toolCursors, [undefined, ""]);
      });
    } finally {
      await fixture.close();
    }
  });

  // A repeated cursor is FOLLOWED, not read as an ending: the spec forbids
  // making determinations on a cursor's value, and a server may legally
  // reissue one constant token — `""` included. MAX_TOOL_PAGES is the bound,
  // and it REFUSES rather than validating against a list it could not finish.
  test("walks a constant cursor to the page cap and refuses rather than validating a partial list", async () => {
    const fixture = await startFixture({
      paginatedTools: {
        server: "billing",
        // One page whose cursor points back at itself: a server reissuing the
        // same token forever.
        pages: [["render_refund"]],
        cursors: [""],
      },
    });
    try {
      await withSuiteFile(IMPORTED_WITH_TOOL_CALLS, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            validateArgv(
              file,
              "--project",
              "Alpha",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl
            ),
            { telemetry: telemetryDisabled }
          )
        );
        // Refusal, not a verdict: an unreadable tool list means the file was
        // never checked, which must not be reported as "invalid".
        assert.equal(run.result.exitCode, 2);
        const output = `${run.stdout}${run.stderr}`;
        assert.match(output, /TOOL_DISCOVERY_UNAVAILABLE/);
        // Not stopped at page two — bounded by our own cap.
        assert.ok(fixture.toolCursors.length > 2);
      });
    } finally {
      await fixture.close();
    }
  });

  test("prompt mentions and assertion expectations are not deterministic references", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(MENTIONS_ONLY, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            validateArgv(
              file,
              "--project",
              "Alpha",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
        assert.deepEqual(envelope.projectValidation?.findings, []);
        // …and it listed no tools: with nothing deterministic in the file
        // there is no tool name to look up, so a listing here would be a
        // round trip bought for no question.
        assert.deepEqual(fixture.toolListings, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("resolves against the environment the file names, not the project's whole server set", async () => {
    const fixture = await startFixture({
      servers: [
        { id: "srv_billing", name: "billing" },
        { id: "srv_legacy", name: "legacy" },
      ],
      // The tool EXISTS — on a server the environment does not include. A
      // union across the project's servers would call this resolved.
      toolsByServer: { billing: ["render_refund"], legacy: ["render_gone"] },
      environments: { prod: ["billing"] },
    });
    try {
      const scoped = IMPORTED_WITH_TOOL_CALLS.replace(
        "target:\n  servers:\n    - name: billing\n",
        "target:\n  servers:\n    - name: billing\n  environment: prod\n"
      );
      await withSuiteFile(scoped, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            validateArgv(
              file,
              "--project",
              "Alpha",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 1, run.stderr);
        const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
        assert.deepEqual(envelope.projectValidation?.targets, [
          "environment prod",
        ]);
        assert.equal(envelope.projectValidation?.findings.length, 1);
        assert.equal(
          envelope.projectValidation?.findings[0].toolName,
          "render_gone"
        );
        // The legacy server was never listed: it is not in the target.
        assert.deepEqual(fixture.toolListings, ["srv_billing"]);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a step scoped to a server outside the target is unresolved there", async () => {
    const fixture = await startFixture({
      servers: [
        { id: "srv_billing", name: "billing" },
        { id: "srv_legacy", name: "legacy" },
      ],
      toolsByServer: { billing: ["render_refund"], legacy: ["render_refund"] },
    });
    try {
      const crossServer = IMPORTED_WITH_TOOL_CALLS.replace(
        "        serverName: billing\n        toolName: render_gone",
        "        serverName: legacy\n        toolName: render_refund"
      );
      await withSuiteFile(crossServer, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            validateArgv(
              file,
              "--project",
              "Alpha",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 1, run.stderr);
        const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
        const [found] = envelope.projectValidation!.findings;
        // The tool name exists on `legacy` — but `legacy` is not in the file's
        // target, so the reference still cannot execute.
        assert.equal(found.code, "TOOL_REFERENCE_UNRESOLVED");
        assert.equal(found.serverName, "legacy");
        assert.match(String(found.message), /not part of/);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a reference must resolve in EVERY target, not in their union", async () => {
    const fixture = await startFixture({
      servers: [
        { id: "srv_billing", name: "billing" },
        { id: "srv_billing_eu", name: "billing" },
      ],
      // Both targets carry a server called `billing`; only one exposes the
      // tool. The union says "resolved"; per-target says "fails in eu".
      toolsByServer: { billing: ["render_refund"] },
      environments: { us: ["billing"], eu: [] },
    });
    try {
      await withSuiteFile(IMPORTED_WITH_TOOL_CALLS, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            validateArgv(
              file,
              "--project",
              "Alpha",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 1, run.stderr);
      });
    } finally {
      await fixture.close();
    }
  });
});

// ── the mandatory pre-sync check on a run ────────────────────────────────────

describe("eval run --file validates before it writes", () => {
  test("an ENABLED unresolved imported case refuses before any write", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stdout);
        // The assertion that matters: NOTHING was written. A refusal after the
        // suite sync would still exit non-zero while leaving the project with
        // a half-authored suite and the caller with a retry that duplicates.
        assert.deepEqual(fixture.fromFileBodies, []);
        assert.deepEqual(fixture.batchBodies, []);
        assert.deepEqual(fixture.runBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a DISABLED unresolved imported case is persisted with a rewritten claim", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(IMPORTED_WITH_TOOL_CALLS, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        const authored = (
          fixture.batchBodies[0] as {
            cases: Array<{ id: string; import?: Record<string, unknown> }>;
          }
        ).cases;
        const rewritten = authored.find((entry) => entry.id === "c_missing")!;
        assert.equal(rewritten.import?.status, "unresolved");
        // Lineage survives the rewrite: which source case this came from is a
        // fact about the import, not about the claim being made for it.
        assert.equal(rewritten.import?.sourceCaseKey, "upstream/refunds/gone");
        assert.match(String(rewritten.import?.note), /render_gone/);
        assert.match(String(rewritten.import?.note), /Previous claim: exact/);
        assert.ok(String(rewritten.import?.note).length <= 2000);
        // The resolvable case keeps the converter's own claim, untouched.
        const kept = authored.find((entry) => entry.id === "c_render")!;
        assert.equal(kept.import?.status, "exact");
        // …and only the enabled case is launched.
        const launched = fixture.runBodies[0] as { caseIds?: string[] };
        assert.deepEqual(launched.caseIds, ["row_c_render"]);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a native case never acquires import provenance from an unresolved reference", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(NATIVE_WITH_TOOL_CALLS, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        const authored = (
          fixture.batchBodies[0] as {
            cases: Array<{ id: string; import?: unknown }>;
          }
        ).cases;
        // Manufacturing a claim here would turn "somebody wrote this by hand"
        // into "something converted this", permanently, on the strength of a
        // tool that is missing today.
        for (const entry of authored) {
          assert.equal("import" in entry, false, entry.id);
        }
      });
    } finally {
      await fixture.close();
    }
  });

  test("a selected NATIVE unresolved case refuses before any write", async () => {
    const fixture = await startFixture();
    try {
      const enabled = NATIVE_WITH_TOOL_CALLS.replace(
        "    disabled: true\n",
        ""
      );
      await withSuiteFile(enabled, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stdout);
        assert.deepEqual(fixture.fromFileBodies, []);
        assert.deepEqual(fixture.batchBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("an enabled unresolved case NOT named by --case does not refuse the run", async () => {
    const fixture = await startFixture();
    try {
      const enabled = IMPORTED_ENABLED_MISSING;
      await withSuiteFile(enabled, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--case", "c_render"), {
            telemetry: telemetryDisabled,
          })
        );
        // Enabled but unselected: the launch never touches it, so refusing
        // would block a run over a case it was not going to execute. The
        // corrected claim is still persisted.
        assert.equal(run.result.exitCode, 0, run.stderr);
        const authored = (
          fixture.batchBodies[0] as {
            cases: Array<{ id: string; import?: Record<string, unknown> }>;
          }
        ).cases;
        assert.equal(
          authored.find((entry) => entry.id === "c_missing")?.import?.status,
          "unresolved"
        );
        assert.deepEqual(
          (fixture.runBodies[0] as { caseIds?: string[] }).caseIds,
          ["row_c_render"]
        );
      });
    } finally {
      await fixture.close();
    }
  });

  test("a prompt-only suite launches with no tool discovery at all", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(PROMPT_ONLY, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        // The check is mandatory, but a file with nothing deterministic in it
        // only has its target resolved — no tool listing is paid for.
        assert.deepEqual(fixture.toolListings, []);
        assert.equal(fixture.runBodies.length, 1);
      });
    } finally {
      await fixture.close();
    }
  });

  test("refuses when the run's target set cannot be enumerated", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--all-targets"), {
            telemetry: telemetryDisabled,
          })
        );
        // `--all-targets` fans out over the suite's attachments, which do not
        // exist yet at check time. Unknowable is not "fine": the file names
        // deterministic tools, and nothing here can say they resolve.
        assert.equal(run.result.exitCode, 2, run.stdout);
        assert.deepEqual(fixture.fromFileBodies, []);
        assert.match(run.stdout + run.stderr, /cannot be enumerated/);
      });
    } finally {
      await fixture.close();
    }
  });
});

// ── per-run approval of approximations ───────────────────────────────────────

describe("eval run --file --allow-approximated", () => {
  const REASON = "Reviewed against the upstream rubric on 2026-08-26.";

  test("sends importApprovals against the HOSTED case ids, with the trimmed reason", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(APPROVAL_SUITE, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            runArgv(
              fixture.baseUrl,
              file,
              "--allow-approximated",
              "c_approx",
              "c_approx_two",
              "--approval-reason",
              `   ${REASON}   `
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        const launched = fixture.runBodies[0] as {
          importApprovals?: Array<{ testCaseId: string; reason: string }>;
        };
        // Hosted row ids, not the authored ones the caller typed: the backend
        // addresses cases by row id, and sending an authored id would be an
        // approval it cannot match to anything.
        assert.deepEqual(launched.importApprovals, [
          { testCaseId: "row_c_approx", reason: REASON },
          { testCaseId: "row_c_approx_two", reason: REASON },
        ]);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a selected approximation with no approval is left for the backend to refuse", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(APPROVAL_SUITE, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        // The CLI does not invent a client-side policy refusal here. The
        // BACKEND owns whether an unapproved approximation may run, and a
        // second implementation of that rule on this side would be one more
        // thing to keep in step with it.
        assert.equal(
          (fixture.runBodies[0] as { importApprovals?: unknown })
            .importApprovals,
          undefined
        );
      });
    } finally {
      await fixture.close();
    }
  });

  for (const [label, selector, expected] of [
    ["a native case", "c_native", /not converted/],
    ["a claimed-exact case", "c_exact", /needs no approval/],
    ["an unsupported case", "c_unsupported", /cannot be approved into running/],
    ["a disabled case", "c_parked", /disabled/],
    ["an unknown case", "c_nope", /not a case id declared/],
  ] as const) {
    test(`refuses an approval naming ${label}, before any write`, async () => {
      const fixture = await startFixture();
      try {
        await withSuiteFile(APPROVAL_SUITE, async (file) => {
          const run = await captureProcessOutput(() =>
            main(
              runArgv(
                fixture.baseUrl,
                file,
                "--allow-approximated",
                selector,
                "--approval-reason",
                REASON
              ),
              { telemetry: telemetryDisabled }
            )
          );
          assert.equal(run.result.exitCode, 2, run.stdout);
          assert.match(run.stdout + run.stderr, expected);
          // Before the writes, so a mistyped approval costs nothing.
          assert.deepEqual(fixture.fromFileBodies, []);
          assert.deepEqual(fixture.batchBodies, []);
          assert.deepEqual(fixture.runBodies, []);
        });
      } finally {
        await fixture.close();
      }
    });
  }

  test("refuses an approval for a case --case left out of the run", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(APPROVAL_SUITE, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            runArgv(
              fixture.baseUrl,
              file,
              "--case",
              "c_approx",
              "--allow-approximated",
              "c_approx_two",
              "--approval-reason",
              REASON
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 2, run.stdout);
        assert.match(
          run.stdout + run.stderr,
          /not among the cases this run executes/
        );
        assert.deepEqual(fixture.runBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  for (const [label, args, expected] of [
    [
      "selectors with no reason",
      ["--allow-approximated", "c_approx"],
      /requires --approval-reason/,
    ],
    [
      "a reason with no selectors",
      ["--approval-reason", "because"],
      /needs at least one --allow-approximated/,
    ],
    [
      "a duplicate selector",
      [
        "--allow-approximated",
        "c_approx",
        "c_approx",
        "--approval-reason",
        "because",
      ],
      /more than once/,
    ],
    [
      "a blank reason",
      ["--allow-approximated", "c_approx", "--approval-reason", "   "],
      /must be 1-500 characters/,
    ],
  ] as const) {
    test(`rejects ${label} as a usage error`, async () => {
      const fixture = await startFixture();
      try {
        await withSuiteFile(APPROVAL_SUITE, async (file) => {
          const run = await captureProcessOutput(() =>
            main(runArgv(fixture.baseUrl, file, ...args), {
              telemetry: telemetryDisabled,
            })
          );
          assert.equal(run.result.exitCode, 2, run.stdout);
          assert.match(run.stdout + run.stderr, expected);
          assert.deepEqual(fixture.fromFileBodies, []);
        });
      } finally {
        await fixture.close();
      }
    });
  }

  test("rejects a 501-character reason", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(APPROVAL_SUITE, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            runArgv(
              fixture.baseUrl,
              file,
              "--allow-approximated",
              "c_approx",
              "--approval-reason",
              "r".repeat(501)
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 2, run.stdout);
        assert.match(run.stdout + run.stderr, /must be 1-500 characters/);
      });
    } finally {
      await fixture.close();
    }
  });

  test("each file invocation gets a fresh key and approval flag order is normalized", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(APPROVAL_SUITE, async (file) => {
        const launch = (...args: string[]) =>
          captureProcessOutput(() =>
            main(runArgv(fixture.baseUrl, file, ...args), {
              telemetry: telemetryDisabled,
            })
          );
        await launch();
        await launch(
          "--allow-approximated",
          "c_approx",
          "c_approx_two",
          "--approval-reason",
          REASON
        );
        await launch(
          "--allow-approximated",
          "c_approx_two",
          "c_approx",
          "--approval-reason",
          REASON
        );
        await launch(
          "--allow-approximated",
          "c_approx",
          "c_approx_two",
          "--approval-reason",
          "A different justification entirely."
        );
        const keys = fixture.runBodies.map(
          (body) => (body as { idempotencyKey: string }).idempotencyKey
        );
        assert.equal(keys.length, 4);
        assert.equal(new Set(keys).size, 4);
        const approvals = fixture.runBodies.map(
          (body) =>
            (body as { importApprovals?: unknown }).importApprovals ?? null
        );
        // The request semantics are independent of the order CLI flags were
        // typed in, even though each invocation has its own retry key.
        const canonicalApprovals = (value: unknown) =>
          Array.isArray(value)
            ? [...value].sort((left, right) =>
                String(left.testCaseId).localeCompare(String(right.testCaseId))
              )
            : value;
        assert.deepEqual(
          canonicalApprovals(approvals[1]),
          canonicalApprovals(approvals[2])
        );
        assert.notDeepEqual(approvals[1], approvals[3]);
      });
    } finally {
      await fixture.close();
    }
  });

  test("refuses the flags on a --suite launch", async () => {
    const fixture = await startFixture();
    try {
      const run = await captureProcessOutput(() =>
        main(
          [
            "node",
            "mcpjam",
            "cloud",
            "eval",
            "run",
            "--suite",
            "Billing smoke",
            "--project",
            "Alpha",
            "--allow-approximated",
            "c_approx",
            "--approval-reason",
            REASON,
            "--api-key",
            "sk_test",
            "--api-url",
            fixture.baseUrl,
            "--format",
            "json",
          ],
          { telemetry: telemetryDisabled }
        )
      );
      assert.equal(run.result.exitCode, 2, run.stdout);
      // A hosted suite's cases are not the ones this invocation authored, so
      // an authored-id selector has nothing to resolve against. Accepting the
      // flags and ignoring them would let somebody believe an approximation
      // had been approved when the run refused it.
      assert.match(run.stdout + run.stderr, /apply to a file run/);
      assert.deepEqual(fixture.runBodies, []);
    } finally {
      await fixture.close();
    }
  });
});

// ── review findings: the three ways a preflight can check the wrong thing ─────
//
// Each of these reproduces a real defect the Codex reviewer found on #4391.
// They are grouped because they share one failure mode: a check that LOOKS like
// it ran, against something other than what the run will actually do. That is
// worse than no check at all, because it is trusted.

describe("the preflight checks what the run will actually execute", () => {
  test("--host validates the HOST's server set, not the file's", async () => {
    const fixture = await startFixture({
      servers: [
        { id: "srv_billing", name: "billing" },
        { id: "srv_legacy", name: "legacy" },
      ],
      // The file targets `billing`, which HAS the tool. The host runs `legacy`,
      // which does not. Validating the file's servers would approve this and
      // then start a paid run on a host that cannot execute the call.
      toolsByServer: { billing: ["render_gone", "render_refund"], legacy: [] },
      hosts: { "Claude Desktop": ["legacy"] },
    });
    try {
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--host", "Claude Desktop"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stdout);
        assert.deepEqual(fixture.fromFileBodies, []);
        assert.deepEqual(fixture.runBodies, []);
        // The finding is scoped to the HOST target, which is what proves the
        // check ran against the host's set rather than the file's.
        assert.match(run.stdout + run.stderr, /host Claude Desktop/);
      });
    } finally {
      await fixture.close();
    }
  });

  test("--host does not refuse a case the host CAN run", async () => {
    const fixture = await startFixture({
      servers: [{ id: "srv_billing", name: "billing" }],
      toolsByServer: { billing: ["render_gone", "render_refund"] },
      hosts: { "Claude Desktop": ["billing"] },
    });
    try {
      // The mirror image of the test above: the file names a server the
      // project no longer has, and the HOST pins the real one. Resolving the
      // file's `target.servers` yields an empty target and refuses a launch
      // that is perfectly fine; resolving the host's set finds both tools.
      const staleFileTarget = IMPORTED_ENABLED_MISSING.replace(
        "target:\n  servers:\n    - name: billing\n",
        "target:\n  servers:\n    - name: retired\n"
      );
      await withSuiteFile(staleFileTarget, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--host", "Claude Desktop"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stdout + run.stderr);
        assert.equal(fixture.runBodies.length, 1);
        assert.deepEqual(fixture.toolListings, ["srv_billing"]);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a host that reports no server set refuses rather than guessing", async () => {
    const fixture = await startFixture({
      hosts: { "Claude Desktop": ["billing"] },
      hostWithUnreadableConfig: "Claude Desktop",
    });
    try {
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--host", "Claude Desktop"), {
            telemetry: telemetryDisabled,
          })
        );
        // "We could not look" is a command error, and falling back to the
        // file's servers would be checking the wrong inventory while claiming
        // to have checked.
        assert.equal(run.result.exitCode, 2, run.stdout);
        assert.match(run.stdout + run.stderr, /did not report a server set/);
        assert.deepEqual(fixture.fromFileBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("an explicitly empty host server set is validated as empty, not as omitted", async () => {
    const fixture = await startFixture({
      servers: [{ id: "srv_billing", name: "billing" }],
      toolsByServer: { billing: ["render_refund", "render_gone"] },
      hosts: { "Claude Desktop": ["billing"] },
    });
    try {
      // `servers: []` on a file host CLEARS the attachment before launch, so
      // the run executes against nothing. Reading it as "omitted" would
      // validate the host's current config — which has both tools — and start
      // a run that cannot execute either.
      const emptyHostServers = IMPORTED_ENABLED_MISSING.replace(
        "target:\n  servers:\n    - name: billing\n",
        "target:\n  servers:\n    - name: billing\n  hosts:\n    - name: Claude Desktop\n      servers: []\n"
      );
      await withSuiteFile(emptyHostServers, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file), { telemetry: telemetryDisabled })
        );
        assert.equal(run.result.exitCode, 2, run.stdout);
        assert.match(
          run.stdout + run.stderr,
          /is not part of host Claude Desktop/
        );
        assert.deepEqual(fixture.fromFileBodies, []);
        // Nothing was listed: the target is empty, so there is no inventory to
        // fetch and the reference fails on the missing server itself.
        assert.deepEqual(fixture.toolListings, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a selector matching one case's title and another's id resolves by id", async () => {
    const fixture = await startFixture();
    try {
      // `c_render`'s TITLE is the string `c_missing`, which is also the later
      // case's authored ID. The launcher resolves ids before titles, so it runs
      // `c_missing` — the one whose deterministic call does not resolve.
      const collide = IMPORTED_ENABLED_MISSING.replace(
        "    title: Renders the refund widget",
        "    title: c_missing"
      );
      await withSuiteFile(collide, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--case", "c_missing"), {
            telemetry: telemetryDisabled,
          })
        );
        // A file-order scan would have picked the title match (`c_render`,
        // which resolves) and let the run start; matching the launcher's
        // id-first precedence refuses before any write.
        assert.equal(run.result.exitCode, 2, run.stdout);
        assert.deepEqual(fixture.fromFileBodies, []);
        assert.deepEqual(fixture.runBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a title shared by a created and an updated case widens instead of guessing", async () => {
    const fixture = await startFixture({
      // `c_old` already exists, so it syncs as an UPDATE while `c_new` is a
      // CREATE — and the launcher orders updates before creates.
      existingCases: [
        { declaredId: "c_old", title: "Renders the refund widget" },
      ],
    });
    try {
      await withSuiteFile(SHARED_TITLE_CREATE_AND_UPDATE, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            runArgv(
              fixture.baseUrl,
              file,
              "--case",
              "Renders the refund widget"
            ),
            { telemetry: telemetryDisabled }
          )
        );
        // Resolving the shared title in AUTHORED order picks `c_old`, whose
        // call resolves, leaves native `c_new` untouched as "unselected", and
        // starts a paid run on the case the launcher actually picks — the one
        // whose call does not resolve. Widening checks every enabled case, so
        // `c_new` is caught before anything is written.
        assert.equal(run.result.exitCode, 2, run.stdout);
        assert.deepEqual(fixture.fromFileBodies, []);
        assert.deepEqual(fixture.runBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("unavailable discovery refuses a selected case without blaming its file", async () => {
    const fixture = await startFixture();
    try {
      // `--all-targets` cannot enumerate the target set before the write, so
      // every deterministic reference comes back UNCHECKED rather than missing.
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--all-targets"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stdout);
        // Refusing is right — not being able to look is a reason to stop. But
        // the reason must be the real one: "could not be checked", never "does
        // not resolve", which would send someone to fix a file that is fine.
        assert.match(run.stdout + run.stderr, /could not be checked/);
        assert.doesNotMatch(
          run.stdout + run.stderr,
          /name a deterministic tool that does not resolve/
        );
        assert.deepEqual(fixture.fromFileBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("unavailable discovery never rewrites an unselected case's claim", async () => {
    const fixture = await startFixture();
    try {
      // `c_hint` is prompt-only, so selecting it leaves the imported case
      // unselected — the path that rewrites claims. Discovery is unavailable
      // under `--all-targets`, so nothing was actually checked.
      const withPromptSibling = IMPORTED_ENABLED_MISSING.replace(
        "cases:\n",
        `cases:
  - id: c_hint
    title: Prompt only
    steps:
      - id: step-1
        kind: prompt
        prompt: Say hello.
`
      );
      await withSuiteFile(withPromptSibling, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            runArgv(fixture.baseUrl, file, "--all-targets", "--case", "c_hint"),
            { telemetry: telemetryDisabled }
          )
        );
        // Whatever else happens, the converter's claim must survive: "we could
        // not enumerate the targets" is not evidence that a tool is missing,
        // and recording `unresolved` on the strength of it would have MCPJam
        // assert something it never checked — permanently, in the hosted row.
        const written = [...fixture.batchBodies, ...fixture.updateBodies];
        const serialized = JSON.stringify(written);
        assert.doesNotMatch(serialized, /"unresolved"/, serialized);
        assert.equal(run.result.exitCode, 0, run.stdout + run.stderr);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a server named in different case resolves, as it does at run time", async () => {
    const fixture = await startFixture({
      servers: [{ id: "srv_billing", name: "GitHub" }],
      toolsByServer: { GitHub: ["render_refund"] },
    });
    try {
      // `resolveConfiguredServerIds` matches a server reference exactly and
      // then case-insensitively, so this run executes. A preflight matching
      // only exactly would refuse a run the runtime resolves fine.
      // The case whose tool is genuinely absent stays DISABLED: this test is
      // about the server name resolving, not about a missing tool.
      const lowercased = IMPORTED_WITH_TOOL_CALLS.replace(/billing/g, "github");
      await withSuiteFile(lowercased, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--server", "GitHub"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.doesNotMatch(run.stdout + run.stderr, /does not resolve/);
        assert.equal(run.result.exitCode, 0, run.stdout + run.stderr);
      });
    } finally {
      await fixture.close();
    }
  });

  test("--server refuses a file-owned environment before syncing anything", async () => {
    const fixture = await startFixture({
      servers: [
        { id: "srv_billing", name: "billing" },
        { id: "srv_alt", name: "alternate" },
      ],
      toolsByServer: {
        billing: ["render_refund", "render_gone"],
        alternate: ["render_refund", "render_gone"],
      },
      environments: { production: ["billing"] },
    });
    try {
      const fileWithEnvironment = IMPORTED_WITH_TOOL_CALLS.replace(
        "target:\n  servers:\n    - name: billing\n",
        "target:\n  servers:\n    - name: billing\n  environment: production\n"
      );
      await withSuiteFile(fileWithEnvironment, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--server", "alternate"), {
            telemetry: telemetryDisabled,
          })
        );

        assert.equal(run.result.exitCode, 2, run.stdout + run.stderr);
        assert.match(
          run.stdout + run.stderr,
          /environment.*production.*--server cannot override.*separate suite file/s
        );
        assert.deepEqual(fixture.fromFileBodies, []);
        assert.deepEqual(fixture.batchBodies, []);
        assert.deepEqual(fixture.updateBodies, []);
        assert.deepEqual(fixture.runBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a host named in different case resolves, as it does at launch", async () => {
    const fixture = await startFixture({
      servers: [{ id: "srv_billing", name: "billing" }],
      toolsByServer: { billing: ["render_refund", "render_gone"] },
      hosts: { "Claude Desktop": ["billing"] },
    });
    try {
      // `resolveByIdOrName` trims and takes a unique case-insensitive name
      // match, so this launches. Matching exactly here would report the host
      // missing and refuse a run that works.
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--host", "claude desktop"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.doesNotMatch(
          run.stdout + run.stderr,
          /is not in this project/,
          run.stdout + run.stderr
        );
        assert.equal(run.result.exitCode, 0, run.stdout + run.stderr);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a host name matching two hosts refuses instead of picking one", async () => {
    const fixture = await startFixture({
      servers: [{ id: "srv_billing", name: "billing" }],
      toolsByServer: { billing: ["render_refund", "render_gone"] },
      hosts: { "Claude Desktop": ["billing"], "claude desktop": ["billing"] },
    });
    try {
      // `resolveByIdOrName` refuses an ambiguous name rather than picking one,
      // so the launch fails here too. Checking whichever host sorted first
      // would vouch for a host the run may never use.
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--host", "CLAUDE DESKTOP"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stdout + run.stderr);
        assert.match(run.stdout + run.stderr, /matches more than one host/);
        assert.deepEqual(fixture.fromFileBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("an ambiguous --server refuses before any write, as the launch would", async () => {
    const fixture = await startFixture({
      servers: [
        { id: "srv_a", name: "GitHub" },
        { id: "srv_b", name: "github" },
      ],
      toolsByServer: { GitHub: ["render_refund", "render_gone"] },
    });
    try {
      // `--server` is resolved at launch by `resolveRunServers` ->
      // `resolveByIdOrName`, which REQUIRES a unique case-insensitive name.
      // Taking the first fold match here would validate, sync the suite and
      // its cases, and only then have the launch reject the selector — writes
      // left behind for a run that never started.
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--server", "GITHUB"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stdout + run.stderr);
        assert.match(run.stdout + run.stderr, /matches more than one server/);
        // The point of the refusal: nothing synced.
        assert.deepEqual(fixture.fromFileBodies, []);
        assert.deepEqual(fixture.batchBodies, []);
        assert.deepEqual(fixture.runBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("an EXACT --server name is still ambiguous when another folds to it", async () => {
    const fixture = await startFixture({
      servers: [
        { id: "srv_a", name: "GitHub" },
        { id: "srv_b", name: "github" },
      ],
      toolsByServer: { GitHub: ["render_refund", "render_gone"] },
    });
    try {
      // `resolveByIdOrName` has NO exact-name fast path: after the id check it
      // goes straight to the folded set, so `GitHub` matches two servers and
      // the launch refuses it — even though the spelling is exactly right.
      // Short-circuiting on the exact name here would sync the suite and its
      // cases and leave the launch to reject the selector afterwards.
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--server", "GitHub"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stdout + run.stderr);
        assert.match(run.stdout + run.stderr, /matches more than one server/);
        assert.deepEqual(fixture.fromFileBodies, []);
        assert.deepEqual(fixture.batchBodies, []);
        assert.deepEqual(fixture.runBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("an exact --server ID resolves even when names collide", async () => {
    const fixture = await startFixture({
      // The two names FOLD together, so a name selector would be ambiguous;
      // the id is what disambiguates. `billing` is the name the file's steps
      // reference, so resolving by id must land on that one.
      servers: [
        { id: "srv_billing", name: "billing" },
        { id: "srv_b", name: "Billing" },
      ],
      toolsByServer: { billing: ["render_refund", "render_gone"] },
    });
    try {
      // An id is unique by construction and every runtime resolver checks ids
      // first, so naming one is exactly how a caller escapes the ambiguity.
      // Refusing here would leave them no way to run at all.
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--server", "srv_billing"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.doesNotMatch(
          run.stdout + run.stderr,
          /matches more than one server/
        );
        assert.equal(run.result.exitCode, 0, run.stdout + run.stderr);
      });
    } finally {
      await fixture.close();
    }
  });

  test("an ambiguous name in the FILE's target.servers still runs", async () => {
    const fixture = await startFixture({
      // NEITHER matches the file's `billing` exactly, so the fold is what
      // decides — which is the whole point of this test.
      servers: [
        { id: "srv_a", name: "Billing" },
        { id: "srv_b", name: "BILLING" },
      ],
      toolsByServer: { Billing: ["render_refund", "render_gone"] },
    });
    try {
      // The file's own `target.servers` are resolved at RUN TIME by
      // `resolveConfiguredServerIds`, which takes the first case-insensitive
      // match and never calls it ambiguous. Refusing here would block a run
      // that executes perfectly well — the binding rule and the explicit
      // `--server` rule are genuinely different, and this pins that.
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file), { telemetry: telemetryDisabled })
        );
        assert.doesNotMatch(
          run.stdout + run.stderr,
          /matches more than one server/
        );
        assert.equal(run.result.exitCode, 0, run.stdout + run.stderr);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a host pinning a server the project lost refuses, and says so", async () => {
    const fixture = await startFixture({
      servers: [{ id: "srv_billing", name: "billing" }],
      toolsByServer: { billing: ["render_refund", "render_gone"] },
      // The host pins a server the project no longer lists.
      hosts: { "Claude Desktop": ["billing", "retired"] },
    });
    try {
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--host", "Claude Desktop"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stdout);
        // The inconsistency is in the PROJECT, not the file. Validating the
        // narrowed set would still fail closed, but with the wrong sentence —
        // sending the author to edit YAML that is fine.
        assert.match(run.stdout + run.stderr, /no longer has/);
        assert.doesNotMatch(run.stdout + run.stderr, /exposes no tool named/);
        assert.deepEqual(fixture.fromFileBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("serverId wins over a stale serverName", async () => {
    const fixture = await startFixture({
      // Two servers; the one the step NAMES sorts first and has the tool, the
      // one it points at by ID does not. An OR match would check the first and
      // approve a call that cannot execute.
      servers: [
        { id: "srv_billing", name: "billing" },
        { id: "srv_billing_v2", name: "billing-v2" },
      ],
      toolsByServer: { billing: ["render_gone"], "billing-v2": [] },
    });
    try {
      const pinnedById = IMPORTED_ENABLED_MISSING.replace(
        "        serverName: billing\n        toolName: render_gone",
        "        serverId: srv_billing_v2\n        serverName: billing\n        toolName: render_gone"
      );
      await withSuiteFile(pinnedById, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            runArgv(fixture.baseUrl, file, "--server", "billing", "billing-v2"),
            {
              telemetry: telemetryDisabled,
            }
          )
        );
        assert.equal(run.result.exitCode, 2, run.stdout);
        assert.deepEqual(fixture.fromFileBodies, []);
        // The id's server was the one inspected.
        assert.ok(fixture.toolListings.includes("srv_billing_v2"));
      });
    } finally {
      await fixture.close();
    }
  });

  test("--case naming a hosted row id still refuses an unresolved case", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          // `selectEnabledRunCases` accepts a hosted row id, but the row ids do
          // not exist yet at preflight. Reading an unmappable selector as
          // "selects nothing" would sail past the refusal and bill a run whose
          // deterministic call is already known not to resolve.
          main(runArgv(fixture.baseUrl, file, "--case", "row_c_missing"), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stdout);
        assert.deepEqual(fixture.fromFileBodies, []);
        assert.deepEqual(fixture.batchBodies, []);
        assert.deepEqual(fixture.runBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a disabled-case approval refuses even when the selection is indeterminate", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(APPROVAL_SUITE, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            runArgv(
              fixture.baseUrl,
              file,
              // Unmappable selector ⇒ indeterminate selection.
              "--case",
              "row_c_approx",
              "--allow-approximated",
              "c_parked",
              "--approval-reason",
              "Reviewed against the upstream rubric."
            ),
            { telemetry: telemetryDisabled }
          )
        );
        // `disabled` is knowable from the file alone, with no selection
        // involved. Sharing the gate with the not-selected check would let this
        // through to the post-sync mapping — a vaguer verdict, reached after
        // the writes this stage exists to precede.
        assert.equal(run.result.exitCode, 2, run.stdout);
        assert.match(run.stdout + run.stderr, /marked disabled/);
        assert.deepEqual(fixture.fromFileBodies, []);
        assert.deepEqual(fixture.batchBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("an approval by authored id survives an unmappable --case selector", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(APPROVAL_SUITE, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            runArgv(
              fixture.baseUrl,
              file,
              "--case",
              "row_c_approx",
              "--allow-approximated",
              "c_approx",
              "--approval-reason",
              "Reviewed against the upstream rubric."
            ),
            { telemetry: telemetryDisabled }
          )
        );
        // Widening the selection must not make the NOT-SELECTED refusal fire on
        // a case that may well be in the run. Refusing here would block a
        // launch the caller got right; the backend re-checks every approval
        // against the cases the run actually executes.
        assert.equal(run.result.exitCode, 0, run.stdout + run.stderr);
        assert.deepEqual(
          (
            fixture.runBodies[0] as {
              importApprovals?: Array<{ testCaseId: string }>;
            }
          ).importApprovals?.map((entry) => entry.testCaseId),
          ["row_c_approx"]
        );
      });
    } finally {
      await fixture.close();
    }
  });

  test("an unmappable --case selector does not refuse an otherwise-clean run", async () => {
    const fixture = await startFixture({
      toolsByServer: { billing: ["render_refund", "render_gone"] },
    });
    try {
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--case", "row_c_missing"), {
            telemetry: telemetryDisabled,
          })
        );
        // Widening the selection is a fail-CLOSED reading of an unknown
        // selector, not a blanket refusal: with every reference resolving there
        // is nothing to refuse, and the launcher settles the selector itself.
        assert.equal(run.result.exitCode, 0, run.stdout + run.stderr);
      });
    } finally {
      await fixture.close();
    }
  });
});
