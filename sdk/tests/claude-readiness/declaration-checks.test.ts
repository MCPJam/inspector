/**
 * The submission's declarations: the read/write answer against the tools'
 * annotations (the portal's own promise), and declarations nobody stood
 * behind (MCPJam's check, which says so).
 */

import type { Tool } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { claudeSubmissionEvidenceFromAnswers } from "../../src/claude-readiness/answers.js";
import { runClaudeDeclarationChecks } from "../../src/claude-readiness/checks/declarations.js";
import type { ClaudeToolListingCompleteness } from "../../src/claude-readiness/checks/tools.js";
import {
  CLAUDE_CONNECTOR_FLOW,
  directoryFieldWordingRevision,
  type DirectoryAnswer,
  type DirectoryAnswerValue,
} from "../../src/directory-readiness/index.js";
import {
  ACKNOWLEDGMENT_VALUES,
  answer,
  completeAnswers,
} from "../support/claude-connector-answers.js";

const STAMP = { evaluatedAt: "2026-08-19T00:00:00.000Z" };
const ACCESS = "claude.submission.access-matches-annotations";
const CONFIRMED = "claude.submission.declarations-confirmed";

function tool(name: string, annotations?: Record<string, unknown>): Tool {
  return {
    name,
    annotations,
    inputSchema: { type: "object", properties: {} },
  } as Tool;
}

const reads = (name: string) => tool(name, { readOnlyHint: true });
const writes = (name: string) =>
  tool(name, { readOnlyHint: false, destructiveHint: true });

function grade(
  answers: DirectoryAnswer[] | undefined,
  tools: Tool[] | undefined,
  listing?: ClaudeToolListingCompleteness
) {
  const findings = runClaudeDeclarationChecks(
    {
      answers: answers && claudeSubmissionEvidenceFromAnswers(answers),
      tools,
      listing,
    },
    STAMP
  );
  const byId = (id: string) => {
    const found = findings.filter((finding) => finding.id === id);
    expect(found, id).toHaveLength(1);
    return found[0];
  };
  return { access: byId(ACCESS), confirmed: byId(CONFIRMED) };
}

describe("the read/write answer against the annotations", () => {
  it("flags the portal's default Read only on a server with write tools", () => {
    // MCPJam's own submission: the form still said Read only over 64 write tools.
    const tools = [
      ...Array.from({ length: 64 }, (_, i) => writes(`write_${i}`)),
      ...Array.from({ length: 71 }, (_, i) => reads(`read_${i}`)),
    ];
    const { access } = grade(completeAnswers(), tools);
    expect(access.status).toBe("violated");
    expect(access.class).toBe("required");
    expect(access.remediation).toBe(
      "Read/write capabilities is still the portal's default, Read only, but 64 of 135 tools are not annotated readOnlyHint: true: write_0, write_1, write_2, write_3, write_4, write_5, write_6, write_7, write_8, write_9 and 54 more. Choose Read and write on the Use cases step, or set readOnlyHint: true on the tools that only read."
    );
    expect(access.details).toMatchObject({
      declared: "read-only",
      origin: "default",
      tools: 135,
      readOnly: 71,
      notReadOnlyCount: 64,
    });
    expect(access.details?.notReadOnly).toHaveLength(50);
  });

  it("counts a tool with no annotations as one that may write", () => {
    const { access } = grade(
      completeAnswers([answer("useCases.access", "read-only")]),
      [reads("list_orders"), tool("sync_orders")]
    );
    expect(access.status).toBe("violated");
    expect(access.remediation).toBe(
      "Read/write capabilities says Read only, but 1 of 2 tools is not annotated readOnlyHint: true: sync_orders. Choose Read and write on the Use cases step, or set readOnlyHint: true on the tools that only read."
    );
  });

  it("passes Read only when every tool says readOnlyHint: true", () => {
    const { access } = grade(completeAnswers(), [
      reads("list_orders"),
      reads("get_order"),
    ]);
    expect(access.status).toBe("satisfied");
  });

  it("flags Write only over tools annotated read-only", () => {
    const { access } = grade(
      completeAnswers([answer("useCases.access", "write-only")]),
      [writes("send_message"), reads("list_channels")]
    );
    expect(access.status).toBe("violated");
    expect(access.remediation).toBe(
      "Read/write capabilities says Write only, but 1 of 2 tools is annotated readOnlyHint: true: list_channels. Choose Read and write on the Use cases step, or correct those annotations."
    );
    expect(access.details).toMatchObject({ readOnlyTools: ["list_channels"] });
  });

  it("flags Read and write when no tool writes", () => {
    const { access } = grade(
      completeAnswers([answer("useCases.access", "read-write")]),
      [reads("list_orders")]
    );
    expect(access.status).toBe("violated");
    expect(access.remediation).toBe(
      "Read/write capabilities says Read and write, but every tool is annotated readOnlyHint: true. Choose Read only on the Use cases step, or correct the annotations on the tools that write."
    );
  });

  it("passes Read and write and Write only when the tools agree", () => {
    const mixed = [reads("list_orders"), writes("create_order")];
    expect(
      grade(completeAnswers([answer("useCases.access", "read-write")]), mixed)
        .access.status
    ).toBe("satisfied");
    expect(
      grade(completeAnswers([answer("useCases.access", "write-only")]), [
        writes("create_order"),
        tool("send_order"),
      ]).access.status
    ).toBe("satisfied");
  });

  it("names the answer it needs when the answer is blank", () => {
    const { access } = grade(
      completeAnswers([answer("useCases.access", null)]),
      [reads("list_orders")]
    );
    expect(access.status).toBe("not-evaluated");
    expect(access.details).toEqual({ missingInput: "useCases.access" });
    expect(access.notEvaluatedReason).toBe(
      "Read/write capabilities has no answer the portal offers, so there is nothing to compare with the tools' annotations"
    );
  });

  it("names the tool listing when the run has none, or only part of one", () => {
    expect(grade(completeAnswers(), undefined).access).toMatchObject({
      status: "not-evaluated",
      details: { missingInput: "toolListing" },
    });
    const partial = grade(completeAnswers(), [reads("a")], {
      complete: false,
      error: "initialize answered 401",
    }).access;
    expect(partial.notEvaluatedReason).toBe(
      "initialize answered 401, so the answer cannot be compared with every tool"
    );
  });

  it("has nothing to compare on a server with no tools", () => {
    expect(grade(completeAnswers(), []).access.status).toBe("not-applicable");
  });

  it("waits for a submission when the run graded none", () => {
    const { access, confirmed } = grade(undefined, [reads("list_orders")]);
    for (const finding of [access, confirmed]) {
      expect(finding.status).toBe("not-evaluated");
      expect(finding.details).toBeUndefined();
    }
  });
});

describe("declarations nobody confirmed", () => {
  it("lists the portal's defaults and the unanswered ones, as MCPJam's check", () => {
    const { confirmed } = grade(
      completeAnswers().filter(
        (entry) => entry.key !== "dataHandling.sponsored"
      ),
      []
    );
    expect(confirmed.status).toBe("violated");
    expect(confirmed.class).toBe("manual-review");
    expect(confirmed.title).toContain("MCPJam check");
    expect(confirmed.remediation).toBe(
      "Nobody has confirmed 5 declarations, so the portal would submit them as they stand. Confirm or change each on its step: Read/write capabilities (the portal's default, Read only), API ownership (the portal's default, We own the API), Personal health data (the portal's default, No), Sponsored content (no answer), Self-tested (no answer). This is an MCPJam check; the portal accepts its own defaults."
    );
    expect(confirmed.details?.unconfirmedCount).toBe(5);
  });

  it("names an imported or reset declaration as such", () => {
    const { confirmed } = grade(
      confirmAll([
        { key: "testLaunch.selfTested", value: true, origin: "reset" },
        { key: "dataHandling.healthData", value: "no", origin: "imported" },
      ]),
      []
    );
    expect(confirmed.remediation).toBe(
      "Nobody has confirmed 2 declarations, so the portal would submit them as they stand. Confirm or change each on its step: Personal health data (imported), Self-tested (reset). This is an MCPJam check; the portal accepts its own defaults."
    );
  });

  it("names a confirmation made before the wording changed", () => {
    const finding = grade(
      confirmAll([
        {
          ...confirmed("dataHandling.healthData", "no"),
          wordingRevision: "2020-01-01",
        },
      ]),
      []
    ).confirmed;
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toContain(
      "Personal health data (confirmed before its wording changed)"
    );
  });

  it("passes once every declaration was set or confirmed", () => {
    expect(grade(confirmAll(), []).confirmed.status).toBe("satisfied");
  });
});

/** Confirmed under the wording the flow shows now. */
function confirmed(key: string, value: DirectoryAnswerValue): DirectoryAnswer {
  return {
    key,
    value,
    origin: "confirmed",
    wordingRevision: directoryFieldWordingRevision(CLAUDE_CONNECTOR_FLOW, key),
  };
}

const CONFIRMATIONS: DirectoryAnswer[] = [
  confirmed("useCases.access", "read-only"),
  { key: "dataHandling.apiOwnership", value: "own", origin: "set" },
  confirmed("dataHandling.healthData", "no"),
  { key: "testLaunch.selfTested", value: true, origin: "set" },
  confirmed("compliance.acknowledgments", ACKNOWLEDGMENT_VALUES),
];

/** A complete submission whose every declaration someone stood behind. */
function confirmAll(changes: DirectoryAnswer[] = []): DirectoryAnswer[] {
  const changed = new Set(changes.map((entry) => entry.key));
  return completeAnswers([
    ...CONFIRMATIONS.filter((entry) => !changed.has(entry.key)),
    ...changes,
  ]);
}
